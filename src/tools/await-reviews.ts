/**
 * pr_await_reviews tool — Non-blocking agent completion check.
 *
 * Performs a SINGLE poll of GitHub API to check agent review status.
 * Returns immediately with current status. The client (orchestrator)
 * decides whether to call again after a delay.
 *
 * This replaces the previous blocking implementation that held the
 * MCP tool call open for minutes, freezing the client session.
 */

import { z } from 'zod';
import type { Octokit } from '@octokit/rest';
import { getDefaultAgents, isInvokableAgent, INVOKABLE_AGENTS, type InvokableAgentId } from '../agents/registry.js';
import { fetchCompletionStatus, type AgentCompletionResult } from '../agents/completion-detector.js';
import { getOctokit } from '../github/octokit.js';

// ============================================================================
// Input/Output Schemas
// ============================================================================

export const AwaitInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  pr: z.number().int().positive(),
  agents: z.array(z.string()).optional(),
  since: z.string().datetime(),
});

export type AwaitInput = z.infer<typeof AwaitInputSchema>;

export interface AgentAwaitStatus {
  agentId: InvokableAgentId;
  name: string;
  ready: boolean;
  /** This specific agent exceeded its maxWaitMs based on elapsed time since `since` */
  agentTimedOut: boolean;
  confidence?: string;
  source?: string;
  lastActivity?: string;
  detail?: string;
}

export interface AwaitResult {
  /** True when ALL agents completed (none timed out) */
  completed: boolean;
  /** True when some agents completed but others timed out (past maxWaitMs) */
  partial: boolean;
  /** Milliseconds elapsed since the `since` timestamp */
  elapsedMs: number;
  agents: AgentAwaitStatus[];
  summary: {
    ready: number;
    pending: number;
    agentTimedOut: number;
    total: number;
  };
  /** Hint for client: suggested delay before next poll (ms) */
  retryAfterMs: number | null;
}

// ============================================================================
// Main Tool Function
// ============================================================================

/**
 * Non-blocking single poll: check agent completion status and return immediately.
 * The client decides whether/when to call again.
 */
export async function prAwaitReviews(
  input: AwaitInput,
  octokit?: Octokit,
): Promise<AwaitResult> {
  const validated = AwaitInputSchema.parse(input);
  const { owner, repo, pr, since } = validated;

  // Resolve agents
  let agents: InvokableAgentId[];
  if (validated.agents && validated.agents.length > 0) {
    agents = validated.agents.filter(
      (id): id is InvokableAgentId => isInvokableAgent(id),
    );
    if (agents.length === 0) {
      agents = getDefaultAgents();
    }
  } else {
    agents = getDefaultAgents();
  }

  const ok = octokit ?? getOctokit();

  // Fetch head SHA for check runs
  let headSha: string | undefined;
  try {
    const prData = await ok.pulls.get({ owner, repo, pull_number: pr });
    headSha = prData.data.head.sha;
  } catch {
    // headSha remains undefined — check runs won't be fetched
  }

  // Single poll — no loop, no blocking
  const detection = await fetchCompletionStatus(owner, repo, pr, agents, since, ok, headSha);
  const elapsedMs = Date.now() - new Date(since).getTime();

  // Check per-agent timeouts based on elapsed time since invocation
  const agentStatuses: AgentAwaitStatus[] = agents.map(agentId => {
    const detected = detection.agents.find(a => a.agentId === agentId);
    const config = INVOKABLE_AGENTS[agentId];
    const maxWaitMs = config?.completionStrategy.maxWaitMs ?? 600_000;
    const isTimedOut = !detected?.ready && elapsedMs >= maxWaitMs;

    return {
      agentId,
      name: detected?.name ?? config?.name ?? agentId,
      ready: detected?.ready ?? false,
      agentTimedOut: isTimedOut,
      confidence: detected?.confidence,
      source: detected?.source,
      lastActivity: detected?.lastActivity,
      detail: detected?.detail ?? (isTimedOut ? `Exceeded maxWaitMs (${Math.round(maxWaitMs / 1000)}s)` : undefined),
    };
  });

  const ready = agentStatuses.filter(a => a.ready).length;
  const agentTimedOut = agentStatuses.filter(a => a.agentTimedOut && !a.ready).length;
  const pending = agentStatuses.filter(a => !a.ready && !a.agentTimedOut).length;
  const total = agentStatuses.length;
  const allReady = ready === total;
  const allSettled = agentStatuses.every(a => a.ready || a.agentTimedOut);
  const someReady = ready > 0 && !allReady;

  // Suggest retry delay: null if all settled (no more polling needed)
  let retryAfterMs: number | null = null;
  if (!allSettled) {
    // Suggest 15s for early polling, 30s after 2 minutes
    retryAfterMs = elapsedMs < 120_000 ? 15_000 : 30_000;
  }

  return {
    completed: allReady,
    partial: someReady && (allSettled || agentTimedOut > 0),
    elapsedMs,
    agents: agentStatuses,
    summary: {
      ready,
      pending,
      agentTimedOut,
      total,
    },
    retryAfterMs,
  };
}
