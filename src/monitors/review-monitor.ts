/**
 * ReviewMonitor — server-side polling for AI review agent completion.
 *
 * Redesigned with:
 * - Per-agent timeout via maxWaitMs from CompletionStrategy
 * - Partial completion: returns results as soon as all agents are ready OR individually timed out
 * - No dedup map: each call gets fresh polling (eliminates stale promise bug)
 * - Uses unified AgentCompletionDetector instead of old status.ts
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Octokit } from '@octokit/rest';
import {
  fetchCompletionStatus,
  type AgentCompletionResult,
  type CompletionDetectionResult,
} from '../agents/completion-detector.js';
import { getOctokit } from '../github/octokit.js';
import { INVOKABLE_AGENTS, type InvokableAgentId } from '../agents/registry.js';

const MAX_POLL_INTERVAL_MS = 120_000;

// ============================================================================
// Types
// ============================================================================

export interface AwaitParams {
  owner: string;
  repo: string;
  pr: number;
  agents: InvokableAgentId[];
  since: string;
  timeoutMs: number;
  pollIntervalMs: number;
  /** Optional per-session Octokit client for mcp-mux session-aware mode */
  octokit?: Octokit;
}

export interface AwaitResult {
  /** True when ALL agents completed successfully (none timed out) */
  completed: boolean;
  /** True when global timeout was reached OR any agent exceeded its per-agent timeout */
  timedOut: boolean;
  /** True when some agents completed but others timed out */
  partial: boolean;
  elapsedMs: number;
  agents: AgentAwaitStatus[];
  summary: {
    ready: number;
    pending: number;
    agentTimedOut: number;
    total: number;
  };
}

export interface AgentAwaitStatus {
  agentId: InvokableAgentId;
  name: string;
  ready: boolean;
  /** This specific agent exceeded its maxWaitMs */
  agentTimedOut: boolean;
  /** Confidence level from completion detector */
  confidence?: string;
  /** Which source confirmed completion */
  source?: string;
  /** ISO timestamp of the activity that confirmed completion */
  lastActivity?: string;
  /** Human-readable detail */
  detail?: string;
}

// ============================================================================
// ReviewMonitor
// ============================================================================

export class ReviewMonitor {
  private readonly server: Server;

  constructor(server: Server) {
    this.server = server;
  }

  /**
   * Block until all agents complete or timeout.
   * Each call starts fresh polling — no dedup map.
   */
  public async awaitReviews(params: AwaitParams): Promise<AwaitResult> {
    const key = this.getMonitorKey(params);
    return this.monitor(params, key);
  }

  private async monitor(
    params: AwaitParams,
    key: string,
  ): Promise<AwaitResult> {
    const { owner, repo, pr, agents, since, timeoutMs } = params;
    let pollIntervalMs = params.pollIntervalMs;
    let rateLimitRetries = 0;
    const startedAt = Date.now();

    // Track per-agent timeout state
    const agentTimedOutSet = new Set<InvokableAgentId>();
    let lastDetection: CompletionDetectionResult | null = null;

    // Fetch head SHA once to avoid re-fetching it on every poll iteration
    let headSha: string | undefined;
    try {
      const ok = params.octokit ?? getOctokit();
      const prData = await ok.pulls.get({ owner, repo, pull_number: pr });
      headSha = prData.data.head.sha;
    } catch {
      // headSha remains undefined; fetchCompletionStatus will fall back to fetching it internally
    }

    while (true) {
      const elapsedMs = Date.now() - startedAt;

      // Global timeout
      if (elapsedMs >= timeoutMs) {
        const result = this.buildResult(lastDetection, agents, agentTimedOutSet, elapsedMs, true);
        this.sendProgress(key, result, true);
        return result;
      }

      // Poll completion status
      try {
        lastDetection = await fetchCompletionStatus(
          owner, repo, pr, agents, since, params.octokit, headSha,
        );
        pollIntervalMs = params.pollIntervalMs;
        rateLimitRetries = 0;
      } catch (error: unknown) {
        if (this.isThrottlingError(error)) {
          rateLimitRetries += 1;
          pollIntervalMs = Math.min(pollIntervalMs * 2, MAX_POLL_INTERVAL_MS);
          this.log('warning',
            `[review-monitor] ${key}: GitHub API rate limit (attempt ${rateLimitRetries}). ` +
            `Backing off to ${Math.round(pollIntervalMs / 1000)}s.`,
          );
        } else {
          const message = error instanceof Error ? error.message : String(error);
          this.log('warning', `[review-monitor] ${key}: GitHub polling error: ${message}`);
        }

        await this.sleep(pollIntervalMs);
        continue;
      }

      // Check per-agent timeouts
      for (const agentId of agents) {
        if (agentTimedOutSet.has(agentId)) continue;
        const agentResult = lastDetection.agents.find(a => a.agentId === agentId);
        if (agentResult?.ready) continue;

        const config = INVOKABLE_AGENTS[agentId];
        if (config && elapsedMs >= config.completionStrategy.maxWaitMs) {
          agentTimedOutSet.add(agentId);
          this.log('warning',
            `[review-monitor] ${key}: ${config.name} exceeded maxWaitMs ` +
            `(${Math.round(config.completionStrategy.maxWaitMs / 1000)}s). Marking as timed out.`,
          );
        }
      }

      // Build result and check if we can exit
      const result = this.buildResult(lastDetection, agents, agentTimedOutSet, elapsedMs, false);
      this.sendProgress(key, result, false);

      // Exit if all agents are either ready or individually timed out
      const allSettled = result.agents.every(a => a.ready || a.agentTimedOut);
      if (allSettled) {
        this.sendProgress(key, result, true);
        return result;
      }

      await this.sleep(pollIntervalMs);
    }
  }

  private buildResult(
    detection: CompletionDetectionResult | null,
    agents: InvokableAgentId[],
    agentTimedOutSet: Set<InvokableAgentId>,
    elapsedMs: number,
    globalTimedOut: boolean,
  ): AwaitResult {
    const agentStatuses: AgentAwaitStatus[] = agents.map(agentId => {
      const detected = detection?.agents.find(a => a.agentId === agentId);
      const config = INVOKABLE_AGENTS[agentId];
      const isAgentTimedOut = agentTimedOutSet.has(agentId);

      return {
        agentId,
        name: detected?.name ?? config?.name ?? agentId,
        ready: detected?.ready ?? false,
        agentTimedOut: isAgentTimedOut,
        confidence: detected?.confidence,
        source: detected?.source,
        lastActivity: detected?.lastActivity,
        detail: detected?.detail ?? (isAgentTimedOut ? 'Exceeded per-agent timeout' : undefined),
      };
    });

    const ready = agentStatuses.filter(a => a.ready).length;
    const agentTimedOut = agentStatuses.filter(a => a.agentTimedOut && !a.ready).length;
    const pending = agentStatuses.filter(a => !a.ready && !a.agentTimedOut).length;
    const total = agentStatuses.length;
    const allReady = ready === total;
    const someReady = ready > 0 && !allReady;

    return {
      completed: allReady,
      timedOut: globalTimedOut || agentTimedOut > 0,
      partial: someReady && (globalTimedOut || agentTimedOut > 0),
      elapsedMs,
      agents: agentStatuses,
      summary: {
        ready,
        pending,
        agentTimedOut,
        total,
      },
    };
  }

  private sendProgress(
    key: string,
    result: AwaitResult,
    isFinal: boolean,
  ): void {
    const state = isFinal
      ? result.timedOut
        ? `timeout after ${Math.round(result.elapsedMs / 1000)}s`
        : result.completed
          ? `completed after ${Math.round(result.elapsedMs / 1000)}s`
          : `settled after ${Math.round(result.elapsedMs / 1000)}s`
      : `polling... ${Math.round(result.elapsedMs / 1000)}s elapsed`;

    const readyNames = result.agents
      .filter(a => a.ready)
      .map(a => `${a.name}(${a.confidence ?? '?'})`)
      .join(', ') || 'none';
    const pendingNames = result.agents
      .filter(a => !a.ready && !a.agentTimedOut)
      .map(a => a.name)
      .join(', ') || 'none';
    const timedOutNames = result.agents
      .filter(a => a.agentTimedOut && !a.ready)
      .map(a => a.name)
      .join(', ');

    let msg = `[review-monitor] ${key} ${state}. ` +
      `Ready: ${result.summary.ready}/${result.summary.total} (${readyNames}); ` +
      `Pending: ${result.summary.pending} (${pendingNames})`;

    if (timedOutNames) {
      msg += `; Agent-timed-out: ${result.summary.agentTimedOut} (${timedOutNames})`;
    }

    this.log('info', msg);
  }

  private isThrottlingError(error: unknown): boolean {
    const status = this.getErrorStatus(error);
    if (status === 429) return true;
    if (status === 403) {
      const msg = error instanceof Error ? error.message.toLowerCase() : '';
      return msg.includes('rate limit') || msg.includes('abuse detection') || msg.includes('secondary rate');
    }
    return false;
  }

  private getErrorStatus(error: unknown): number | null {
    const errObj = error as { status?: unknown; response?: { status?: unknown } } | null;
    if (errObj && typeof errObj.status === 'number') return errObj.status;
    if (errObj?.response && typeof errObj.response.status === 'number') return errObj.response.status;

    if (error instanceof Error) {
      const messageStatusMatch = /\b(403|429)\b/.exec(error.message);
      if (messageStatusMatch) return Number(messageStatusMatch[0]);
    }

    return null;
  }

  private getMonitorKey(params: AwaitParams): string {
    const agentsSorted = [...params.agents].sort().join(',');
    return `${params.owner}/${params.repo}#${params.pr}@${params.since}[${agentsSorted}]`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
  }

  private log(level: 'info' | 'warning', message: string): void {
    try {
      this.server.sendLoggingMessage({
        level,
        logger: 'review-monitor',
        data: message,
      });
    } catch {
      console.error(`[review-monitor] ${message}`);
    }
  }
}
