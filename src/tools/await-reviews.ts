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
import { fetchCompletionStatus } from '../agents/completion-detector.js';
import { getOctokit } from '../github/octokit.js';
import type { InvocationStore } from '../persistence/invocation-store.js';

// ============================================================================
// Input/Output Schemas
// ============================================================================

export const AwaitInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  pr: z.number().int().positive(),
  agents: z.array(z.string()).optional(),
  /** ISO 8601 timestamp from pr_invoke response. Optional if an active invocation exists in the store. */
  since: z.string().datetime().optional(),
  /** If true, bypass cached agent status and always poll GitHub. Default: false. */
  force: z.boolean().optional().default(false),
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
  /** Set when the call cannot proceed (e.g., no active invocation found) */
  error?: string;
}

// ============================================================================
// Main Tool Function
// ============================================================================

/**
 * Non-blocking single poll: check agent completion status and return immediately.
 * The client decides whether/when to call again.
 *
 * `since` and `agents` are optional when an InvocationStore is provided — the store
 * is queried for the most recent active invocation for the PR and its values are used
 * as defaults.
 */
export async function prAwaitReviews(
  input: AwaitInput,
  octokit?: Octokit,
  invocationStore?: InvocationStore,
  invocationId?: number,
): Promise<AwaitResult> {
  const validated = AwaitInputSchema.parse(input);
  const { owner, repo, pr, force } = validated;

  // Resolve since / agents — explicit values take priority; fall back to active invocation.
  let since = validated.since;
  let agentIds: string[] | undefined = validated.agents;

  if ((!since || !agentIds?.length) && invocationStore) {
    const active = invocationStore.findActiveForPR(owner, repo, pr);
    if (active) {
      since = since ?? active.since;
      agentIds = agentIds?.length ? agentIds : active.agents.filter(isInvokableAgent);
      // Bind to the discovered invocation id (unless caller already supplied one).
      invocationId = invocationId ?? active.id;
    }
  }

  if (!since) {
    return {
      completed: false,
      partial: false,
      elapsedMs: 0,
      agents: [],
      summary: { ready: 0, pending: 0, agentTimedOut: 0, total: 0 },
      retryAfterMs: null,
      error: 'No active invocation found for this PR. Call pr_invoke first, or supply a `since` timestamp.',
    };
  }

  // Resolve final agent list
  let agents: InvokableAgentId[];
  if (agentIds && agentIds.length > 0) {
    agents = agentIds.filter((id): id is InvokableAgentId => isInvokableAgent(id));
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
  // `force` is reserved for future cache-skip behaviour; currently we always poll GitHub.
  void force;
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

  // Persist agent status to SQLite so pr_sessions can reflect current state.
  if (invocationStore && invocationId !== undefined) {
    try {
      // Augment the typed detection results with the per-agent timedOut flag we computed
      // above (the detector itself doesn't know elapsed wall-clock time).
      const timedOutSet = new Set(
        agentStatuses.filter(s => s.agentTimedOut).map(s => s.agentId),
      );
      const resultsWithTimeout = detection.agents.map(r => ({
        ...r,
        timedOut: timedOutSet.has(r.agentId),
      }));
      // Also add any agents that timed out before the detector even saw them.
      for (const s of agentStatuses) {
        if (s.agentTimedOut && !detection.agents.find(r => r.agentId === s.agentId)) {
          resultsWithTimeout.push({
            agentId: s.agentId,
            name: s.name,
            ready: false,
            confidence: 'low',
            source: undefined,
            lastActivity: undefined,
            detail: s.detail,
            timedOut: true,
          });
        }
      }
      invocationStore.updateAgentStatus(invocationId, resultsWithTimeout);
    } catch {
      // Non-fatal — polling result is still returned to the caller.
    }
  }

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
