/**
 * pr_sessions tool — list active and recent review invocations across sessions.
 * Useful for recovery after crash or context compaction.
 */

import { z } from 'zod';
import type { InvocationStore } from '../persistence/invocation-store.js';

// ============================================================================
// Input/Output Schemas
// ============================================================================

export const SessionsInputSchema = z.object({
  owner: z.string().optional().describe('Filter by repository owner'),
  repo: z.string().optional().describe('Filter by repository name'),
  pr: z.number().int().positive().optional().describe('Filter by PR number'),
  status: z.enum(['active', 'completed', 'all']).optional().default('all')
    .describe('Filter by invocation status (default: all)'),
  limit: z.number().int().positive().optional().default(20)
    .describe('Maximum number of results to return (default: 20)'),
});

export type SessionsInput = z.infer<typeof SessionsInputSchema>;

export interface SessionsOutput {
  invocations: Array<{
    id: number;
    owner: string;
    repo: string;
    pr: number;
    sessionId: string;
    agents: string[];
    since: string;
    invokedAt: string;
    status: string;
    completedAt: string | null;
    agentStatuses: Array<{
      agentId: string;
      ready: boolean;
      confidence: string | null;
      lastActivity: string | null;
      timedOut: boolean;
    }>;
  }>;
  total: number;
}

// ============================================================================
// Tool Function
// ============================================================================

/**
 * List active and recent review invocations.
 * Returns empty results when the DB is unavailable (graceful degradation).
 */
export function prSessions(
  input: SessionsInput,
  invocationStore: InvocationStore | null,
): SessionsOutput {
  if (!invocationStore) {
    return { invocations: [], total: 0 };
  }

  const validated = SessionsInputSchema.parse(input);

  // Reap stale invocations before listing so callers see accurate state
  invocationStore.reap();

  const invocations = invocationStore.listSessions({
    owner: validated.owner,
    repo: validated.repo,
    pr: validated.pr,
    status: validated.status === 'all' ? undefined : validated.status,
    limit: validated.limit,
  });

  const enriched = invocations.map(inv => ({
    id: inv.id,
    owner: inv.owner,
    repo: inv.repo,
    pr: inv.pr,
    sessionId: inv.sessionId,
    agents: inv.agents,
    since: inv.since,
    invokedAt: inv.invokedAt,
    status: inv.status,
    completedAt: inv.completedAt,
    agentStatuses: invocationStore.getAgentStatuses(inv.id).map(a => ({
      agentId: a.agentId,
      ready: a.ready,
      confidence: a.confidence,
      lastActivity: a.lastActivity,
      timedOut: a.timedOut,
    })),
  }));

  return { invocations: enriched, total: enriched.length };
}
