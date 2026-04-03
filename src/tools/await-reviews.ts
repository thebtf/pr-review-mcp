/**
 * pr_await_reviews tool — Block until AI review agents complete.
 *
 * Server-side blocking tool that replaces client-side manual polling loops.
 * Polls GitHub internally, sends progress via MCP logging, returns when
 * all agents have posted reviews or timeout is reached.
 */

import { z } from 'zod';
import { getDefaultAgents, isInvokableAgent, type InvokableAgentId } from '../agents/registry.js';
import {
  ReviewMonitor,
  type AwaitResult as ReviewMonitorAwaitResult
} from '../monitors/review-monitor.js';

// ============================================================================
// Input/Output Schemas
// ============================================================================

export const AwaitInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  pr: z.number().int().positive(),
  agents: z.array(z.string()).optional(),
  since: z.string().datetime(),
  timeout_ms: z.number().int().positive().optional().default(600000),
  poll_interval_ms: z.number().int().positive().optional().default(15000),
});

export type AwaitInput = z.infer<typeof AwaitInputSchema>;
export type AwaitResult = ReviewMonitorAwaitResult;

// ============================================================================
// Main Tool Function
// ============================================================================

/**
 * Block until all specified agents have posted reviews, or timeout.
 */
export async function prAwaitReviews(
  input: AwaitInput,
  monitor: ReviewMonitor,
): Promise<AwaitResult> {
  const validated = AwaitInputSchema.parse(input);
  const { owner, repo, pr, since, timeout_ms, poll_interval_ms } = validated;

  // Resolve agents from input; fall back to configured defaults.
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

  return monitor.awaitReviews({
    owner,
    repo,
    pr,
    agents,
    since,
    timeoutMs: timeout_ms,
    pollIntervalMs: poll_interval_ms,
  });
}
