/**
 * WaitState classification for pending AI review agents.
 *
 * Shared between pr_await_reviews and pr_poll_updates so the classification
 * logic stays in a single place.
 */

import { INVOKABLE_AGENTS, type InvokableAgentId } from '../agents/registry.js';

// ============================================================================
// Types
// ============================================================================

export type WaitState = 'normal' | 'slow' | 'stalled' | 'provider_limit' | 'timed_out';

export interface WaitStateFields {
  waitState: WaitState;
  expectedTimeExceeded: boolean;
  /** Milliseconds since last observed signal; null means no signal ever seen */
  noProgressSinceMs: number | null;
  /** Raw provider clue when waitState === 'provider_limit' */
  providerClue?: string;
}

// ============================================================================
// Classification
// ============================================================================

/**
 * Classify the wait state for a single non-ready agent.
 *
 * @param agentId       Registry agent identifier
 * @param elapsedMs     Milliseconds elapsed since the `since` timestamp
 * @param timedOut      Whether the agent exceeded its per-agent maxWaitMs
 * @param lastActivity  ISO timestamp of the last observed signal, or undefined
 * @param detail        Human-readable detail string from the completion detector
 */
export function classifyWaitState(
  agentId: InvokableAgentId,
  elapsedMs: number,
  timedOut: boolean,
  lastActivity: string | undefined,
  detail: string | undefined,
): WaitStateFields {
  const config = INVOKABLE_AGENTS[agentId];
  const expectedTimeMs = config?.completionStrategy.expectedTimeMs ?? 300_000;

  const expectedTimeExceeded = elapsedMs >= expectedTimeMs;

  const noProgressSinceMs =
    lastActivity != null ? Date.now() - new Date(lastActivity).getTime() : null;

  if (timedOut) {
    return { waitState: 'timed_out', expectedTimeExceeded, noProgressSinceMs };
  }

  if (
    detail != null &&
    config?.completionStrategy.excludePatterns?.some(p => p.test(detail))
  ) {
    return {
      waitState: 'provider_limit',
      expectedTimeExceeded,
      noProgressSinceMs,
      providerClue: detail,
    };
  }

  if (!expectedTimeExceeded) {
    return { waitState: 'normal', expectedTimeExceeded, noProgressSinceMs };
  }

  if (lastActivity != null && noProgressSinceMs !== null && noProgressSinceMs <= 2 * 60 * 1000) {
    return { waitState: 'slow', expectedTimeExceeded, noProgressSinceMs };
  }

  return { waitState: 'stalled', expectedTimeExceeded, noProgressSinceMs };
}
