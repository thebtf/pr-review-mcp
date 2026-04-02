/**
 * ReviewMonitor — server-side polling for AI review agent completion.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Octokit } from '@octokit/rest';
import { fetchAgentStatusForAgents, type AgentStatus } from '../agents/status.js';
import type { InvokableAgentId } from '../agents/registry.js';

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
  completed: boolean;
  timedOut: boolean;
  elapsedMs: number;
  agents: AgentStatus[];
  summary: {
    ready: number;
    pending: number;
    total: number;
  };
}

interface ActiveMonitor {
  promise: Promise<AwaitResult>;
  cancel: () => void;
}

// ============================================================================
// ReviewMonitor
// ============================================================================

export class ReviewMonitor {
  private readonly server: Server;
  private readonly activeMonitors = new Map<string, ActiveMonitor>();

  constructor(server: Server) {
    this.server = server;
  }

  public async awaitReviews(params: AwaitParams): Promise<AwaitResult> {
    const key = this.getMonitorKey(params);

    const existing = this.activeMonitors.get(key);
    if (existing) {
      return existing.promise;
    }

    const controller = new AbortController();
    const cancel = () => {
      controller.abort();
    };

    const promise = this.monitor(params, key, controller.signal)
      .finally(() => {
        this.activeMonitors.delete(key);
      });

    this.activeMonitors.set(key, {
      promise,
      cancel,
    });

    return promise;
  }

  private async monitor(
    params: AwaitParams,
    key: string,
    signal: AbortSignal,
  ): Promise<AwaitResult> {
    const { owner, repo, pr, agents, since, timeoutMs } = params;
    let pollIntervalMs = params.pollIntervalMs;
    let rateLimitRetries = 0;
    const startedAt = Date.now();
    let status = this.createFallbackStatus(agents);

    while (!signal.aborted) {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= timeoutMs) {
        const timeoutResult = this.buildResult(status, elapsedMs, true);
        this.sendProgress(key, timeoutResult, true);
        return timeoutResult;
      }

      try {
        status = await fetchAgentStatusForAgents(owner, repo, pr, agents, since, params.octokit);
        pollIntervalMs = params.pollIntervalMs;
        rateLimitRetries = 0;
      } catch (error: unknown) {
        if (this.isThrottlingError(error)) {
          rateLimitRetries += 1;
          pollIntervalMs = Math.min(pollIntervalMs * 2, MAX_POLL_INTERVAL_MS);
          this.log('warning',
            `[review-monitor] ${key}: GitHub API rate limit (attempt ${rateLimitRetries}). ` +
            `Backing off to ${Math.round(pollIntervalMs / 1000)}s.`
          );
        } else {
          const message = error instanceof Error ? error.message : String(error);
          this.log('warning', `[review-monitor] ${key}: GitHub polling error: ${message}`);
        }

        await this.sleep(pollIntervalMs, signal);
        continue;
      }

      const result = this.buildResult(status, elapsedMs, false);
      this.sendProgress(key, result, false);

      if (result.completed) {
        return result;
      }

      await this.sleep(pollIntervalMs, signal);
    }

    const canceledResult = this.buildResult(status, Date.now() - startedAt, false);
    this.sendProgress(key, canceledResult, true);
    return canceledResult;
  }

  private buildResult(
    status: { allAgentsReady: boolean; agents: AgentStatus[] },
    elapsedMs: number,
    timedOut: boolean,
  ): AwaitResult {
    const ready = status.agents.filter(agent => agent.ready).length;
    const total = status.agents.length;

    return {
      completed: !timedOut && status.allAgentsReady,
      timedOut,
      elapsedMs,
      agents: status.agents,
      summary: {
        ready,
        pending: total - ready,
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
        : `finished after ${Math.round(result.elapsedMs / 1000)}s`
      : `polling... ${Math.round(result.elapsedMs / 1000)}s elapsed`;

    const ready = result.agents
      .filter(agent => agent.ready)
      .map(agent => agent.name)
      .join(', ') || 'none';
    const pending = result.agents
      .filter(agent => !agent.ready)
      .map(agent => agent.name)
      .join(', ') || 'none';

    this.log('info',
      `[review-monitor] ${key} ${state}. ` +
      `Ready: ${result.summary.ready}/${result.summary.total} (${ready}); ` +
      `Pending: ${result.summary.pending} (${pending})`
    );
  }

  private createFallbackStatus(agents: InvokableAgentId[]) {
    const fallbackAgents: AgentStatus[] = agents.map(agentId => ({
      agentId,
      name: agentId,
      ready: false,
    }));

    return {
      allAgentsReady: false,
      agents: fallbackAgents,
    };
  }

  private isThrottlingError(error: unknown): boolean {
    // 429 is always rate limit. 403 is rate limit ONLY if message contains
    // "rate limit" or "abuse detection" — otherwise it's an auth/permission error.
    const status = this.getErrorStatus(error);
    if (status === 429) return true;
    if (status === 403) {
      const msg = error instanceof Error ? error.message.toLowerCase() : '';
      return msg.includes('rate limit') || msg.includes('abuse detection') || msg.includes('secondary rate');
    }
    return false;
  }

  private getErrorStatus(error: unknown): number | null {
    // Check Octokit-style error.status / error.response.status
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

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }

      const timer = setTimeout(resolve, ms);
      const handleAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };

      signal.addEventListener('abort', handleAbort, { once: true });
    });
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
