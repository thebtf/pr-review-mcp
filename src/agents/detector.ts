/**
 * Agent detection module — thin wrapper around AgentCompletionDetector.
 *
 * Used by pr_invoke to detect which agents have already reviewed a PR
 * and skip re-invocation. Delegates all detection logic to the unified
 * completion-detector.ts engine.
 */

import { GitHubClient } from '../github/client.js';
import type { Octokit } from '@octokit/rest';
import { getOctokit } from '../github/octokit.js';
import {
  fetchCompletionStatus,
  matchesAuthorPattern as unifiedMatchesAuthorPattern,
} from './completion-detector.js';
import { INVOKABLE_AGENTS, getInvokableAgentIds, type InvokableAgentId } from './registry.js';
import { logger } from '../logging.js';

// ============================================================================
// Types
// ============================================================================

export interface DetectionResult {
  /** Set of agents that have already reviewed this PR */
  reviewed: Set<InvokableAgentId>;
  /** Set of agents that have been requested but not yet reviewed */
  pending: Set<InvokableAgentId>;
  /** Details about each detected agent */
  details: AgentDetectionDetail[];
}

export interface AgentDetectionDetail {
  agentId: InvokableAgentId;
  status: 'reviewed' | 'pending';
  reviewedAt?: string;
  reviewAuthor: string;
}

// ============================================================================
// Author Matching (delegates to unified implementation)
// ============================================================================

/**
 * Check if a login matches an agent's author pattern.
 * @internal Exported for testing
 */
export function matchesAuthorPattern(login: string, pattern: string | string[]): boolean {
  return unifiedMatchesAuthorPattern(login, pattern);
}

/**
 * Get agent ID from author login.
 * @internal Exported for testing
 */
export function getAgentFromAuthor(login: string): InvokableAgentId | null {
  for (const agentId of getInvokableAgentIds()) {
    const config = INVOKABLE_AGENTS[agentId];
    if (unifiedMatchesAuthorPattern(login, config.authorPattern)) {
      return agentId;
    }
  }
  return null;
}

// ============================================================================
// Detection (delegates to unified AgentCompletionDetector)
// ============================================================================

/**
 * Detect which agents have already reviewed a PR.
 *
 * Note: This function does NOT filter by `since` — it checks all time,
 * which is correct for pr_invoke skip logic (we want to know if the agent
 * has EVER reviewed this PR, not just since a specific timestamp).
 *
 * Also checks requested reviewers for pending status (not in completion-detector).
 */
export async function detectReviewedAgents(
  _client: GitHubClient,
  owner: string,
  repo: string,
  pr: number,
  octokit?: Octokit,
): Promise<DetectionResult> {
  const reviewed = new Set<InvokableAgentId>();
  const pending = new Set<InvokableAgentId>();
  const details: AgentDetectionDetail[] = [];

  try {
    const ok = octokit ?? getOctokit();
    const allAgents = getInvokableAgentIds();

    // Use unified completion detector (since=null means all time)
    const detection = await fetchCompletionStatus(owner, repo, pr, allAgents, null, ok);

    for (const agentResult of detection.agents) {
      if (agentResult.ready) {
        reviewed.add(agentResult.agentId);
        details.push({
          agentId: agentResult.agentId,
          status: 'reviewed',
          reviewedAt: agentResult.lastActivity,
          reviewAuthor: agentResult.agentId,
        });
        logger.debug(
          `[detector] Found ${agentResult.agentId} review ` +
          `(${agentResult.confidence}, source: ${agentResult.source ?? 'unknown'})`,
        );
      }
    }

    // Check requested reviewers for pending status
    const prData = await ok.pulls.get({ owner, repo, pull_number: pr });
    const requestedReviewers = prData.data.requested_reviewers ?? [];
    for (const reviewer of requestedReviewers) {
      if (!reviewer || !('login' in reviewer)) continue;
      const login = reviewer.login;
      const agentId = getAgentFromAuthor(login);
      if (agentId && !reviewed.has(agentId) && !pending.has(agentId)) {
        pending.add(agentId);
        details.push({
          agentId,
          status: 'pending',
          reviewAuthor: login,
        });
        logger.debug(`[detector] Found ${agentId} pending review request for ${login}`);
      }
    }

    const reviewedList = [...reviewed].join(', ') || 'none';
    const pendingList = [...pending].join(', ') || 'none';
    logger.info(`[detector] Detection complete - reviewed: ${reviewedList}, pending: ${pendingList}`);
  } catch (error) {
    logger.warning(`[detector] Error detecting reviewed agents: ${error}`);
  }

  return { reviewed, pending, details };
}
