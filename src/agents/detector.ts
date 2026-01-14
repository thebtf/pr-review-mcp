/**
 * Agent detection module
 * Detects which AI review agents have already reviewed or are pending review
 */

import { GitHubClient } from '../github/client.js';
import { QUERIES } from '../github/queries.js';
import { ListReviewsData } from '../github/types.js';
import { getOctokit } from '../github/octokit.js';
import { fetchQodoReview } from '../adapters/qodo.js';
import { INVOKABLE_AGENTS, InvokableAgentId, getInvokableAgentIds } from './registry.js';
import { logger } from '../logging.js';

/**
 * Result of agent detection
 */
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

/**
 * Check if a login matches an agent's author pattern
 * @internal Exported for testing
 */
export function matchesAuthorPattern(login: string, pattern: string | string[]): boolean {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  const normalizedLogin = login.toLowerCase();
  
  return patterns.some(p => {
    const normalizedPattern = p.toLowerCase();
    // Handle both exact match and [bot] suffix
    return normalizedLogin === normalizedPattern ||
           normalizedLogin === `${normalizedPattern}[bot]` ||
           normalizedLogin.startsWith(normalizedPattern);
  });
}

/**
 * Get agent ID from author login
 * @internal Exported for testing
 */
export function getAgentFromAuthor(login: string): InvokableAgentId | null {
  for (const agentId of getInvokableAgentIds()) {
    const config = INVOKABLE_AGENTS[agentId];
    if (matchesAuthorPattern(login, config.authorPattern)) {
      return agentId;
    }
  }
  return null;
}

/**
 * Detect which agents have already reviewed a PR
 * 
 * @param client - GitHub GraphQL client
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param pr - Pull request number
 * @returns Set of agent IDs that have already reviewed
 */
export async function detectReviewedAgents(
  client: GitHubClient,
  owner: string,
  repo: string,
  pr: number
): Promise<DetectionResult> {
  const reviewed = new Set<InvokableAgentId>();
  const pending = new Set<InvokableAgentId>();
  const details: AgentDetectionDetail[] = [];

  try {
    const octokit = getOctokit();
    
    // Fetch reviews, Qodo, requested reviewers, and check runs in parallel
    const [reviewsData, qodoReview, prData] = await Promise.all([
      client.graphql<ListReviewsData>(QUERIES.listReviews, { owner, repo, pr }),
      fetchQodoReview(owner, repo, pr),
      octokit.pulls.get({ owner, repo, pull_number: pr })
    ]);

    const headSha = prData.data.head.sha;

    // Fetch check runs for the head SHA (agents like CodeRabbit run as GitHub Checks)
    let checkRuns: { name: string; status: string; conclusion: string | null; app?: { slug?: string } }[] = [];
    try {
      const allCheckRuns = await octokit.paginate(octokit.checks.listForRef, {
        owner,
        repo,
        ref: headSha,
      });
      checkRuns = allCheckRuns.map(cr => ({
        name: cr.name,
        status: cr.status,
        conclusion: cr.conclusion,
        app: cr.app ? { slug: cr.app.slug } : undefined
      }));
    } catch (e) {
      logger.debug(`[detector] Could not fetch check runs: ${e}`);
    }

    // Process PR reviews (completed)
    const reviews = reviewsData?.repository?.pullRequest?.reviews?.nodes || [];
    
    for (const review of reviews) {
      const login = review.author?.login;
      if (!login) continue;

      const agentId = getAgentFromAuthor(login);
      if (agentId && !reviewed.has(agentId)) {
        reviewed.add(agentId);
        details.push({
          agentId,
          status: 'reviewed',
          reviewAuthor: login,
          reviewedAt: undefined
        });
        logger.debug(`[detector] Found ${agentId} review by ${login}`);
      }
    }

    // Check Qodo (uses issue comments, not PR reviews)
    if (qodoReview) {
      reviewed.add('qodo');
      details.push({
        agentId: 'qodo',
        status: 'reviewed',
        reviewAuthor: 'qodo-code-review[bot]'
      });
      logger.debug('[detector] Found Qodo review via issue comment');
    }

    // Check requested reviewers (pending)
    const requestedReviewers = prData.data.requested_reviewers || [];
    for (const reviewer of requestedReviewers) {
      if (!reviewer || !('login' in reviewer)) continue;
      const login = reviewer.login;
      
      const agentId = getAgentFromAuthor(login);
      // Only add to pending if not already reviewed
      if (agentId && !reviewed.has(agentId) && !pending.has(agentId)) {
        pending.add(agentId);
        details.push({
          agentId,
          status: 'pending',
          reviewAuthor: login
        });
        logger.debug(`[detector] Found ${agentId} pending review request for ${login}`);
      }
    }

    // Check GitHub Check Runs for in-progress agents
    // Map check app slugs to agent IDs
    const checkAppToAgent: Record<string, InvokableAgentId> = {
      'coderabbitai': 'coderabbit',
      'coderabbit': 'coderabbit',
      'gemini-code-assist': 'gemini',
      'sourcery-ai': 'sourcery',
      'sourcery': 'sourcery'
    };

    for (const checkRun of checkRuns) {
      const appSlug = checkRun.app?.slug?.toLowerCase() || '';
      const agentId = checkAppToAgent[appSlug];
      
      if (agentId) {
        // Check run found for this agent
        if (checkRun.status === 'completed' && checkRun.conclusion) {
          // Completed check - agent has reviewed (if not already in reviewed set)
          if (!reviewed.has(agentId)) {
            reviewed.add(agentId);
            details.push({
              agentId,
              status: 'reviewed',
              reviewAuthor: `${appSlug}[bot]`
            });
            logger.debug(`[detector] Found ${agentId} via completed check run (${checkRun.name})`);
          }
        } else if (checkRun.status === 'in_progress' || checkRun.status === 'queued') {
          // In-progress or queued check - agent is processing
          if (!reviewed.has(agentId) && !pending.has(agentId)) {
            pending.add(agentId);
            details.push({
              agentId,
              status: 'pending',
              reviewAuthor: `${appSlug}[bot]`
            });
            logger.debug(`[detector] Found ${agentId} in-progress check run (${checkRun.name}, status: ${checkRun.status})`);
          }
        }
      }
    }

    const reviewedList = [...reviewed].join(', ') || 'none';
    const pendingList = [...pending].join(', ') || 'none';
    logger.info(`[detector] Detection complete - reviewed: ${reviewedList}, pending: ${pendingList}`);

  } catch (error) {
    logger.warning(`[detector] Error detecting reviewed agents: ${error}`);
    // Return empty result on error - safer to re-invoke than to skip
  }

  return { reviewed, pending, details };
}
