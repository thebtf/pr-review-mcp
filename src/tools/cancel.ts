/**
 * pr_cancel tool — Cancel an active review invocation.
 *
 * Looks up an invocation by ID or by (owner, repo, pr) and transitions it
 * from 'active' to 'cancelled'. Terminal invocations (completed, partial,
 * timed_out, stale, cancelled) are returned as alreadyTerminal=true without
 * modification.
 */

import { z } from 'zod';
import type { InvocationStore } from '../persistence/invocation-store.js';

// ============================================================================
// Schema
// ============================================================================

export const CancelInputSchema = z.object({
  owner: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  pr: z.number().int().positive().optional(),
  invocationId: z.number().int().positive().optional(),
}).refine(
  data => data.invocationId !== undefined || (data.owner && data.repo && data.pr !== undefined),
  { message: 'Provide either invocationId or (owner, repo, pr)' },
);

export type CancelInput = z.infer<typeof CancelInputSchema>;

// ============================================================================
// Result type
// ============================================================================

export interface CancelResult {
  cancelled: boolean;
  alreadyTerminal?: boolean;
  invocationId?: number;
  status?: string;
  error?: string;
}

// ============================================================================
// Implementation
// ============================================================================

export function prCancel(input: CancelInput, invocationStore: InvocationStore): CancelResult {
  const validated = CancelInputSchema.parse(input);

  // Locate the target invocation.
  let invocation;
  if (validated.invocationId !== undefined) {
    invocation = invocationStore.findById(validated.invocationId);
  } else {
    invocation = invocationStore.findActiveForPR(validated.owner!, validated.repo!, validated.pr!);
  }

  if (!invocation) {
    return { cancelled: false, error: 'No matching invocation found' };
  }

  // Already in a terminal state — report without mutating.
  if (invocation.status !== 'active') {
    return {
      cancelled: false,
      alreadyTerminal: true,
      invocationId: invocation.id,
      status: invocation.status,
    };
  }

  // Transition to cancelled.
  invocationStore.updateStatus(invocation.id, 'cancelled');
  return { cancelled: true, invocationId: invocation.id };
}
