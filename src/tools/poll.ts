/**
 * pr_poll_updates tool - Stateless polling for PR review updates
 *
 * Returns new comments, resolved threads, commits, and check status since a timestamp.
 * Enables review cycle automation without stateful monitoring.
 */

import { z } from 'zod';
import { getOctokit } from '../github/octokit.js';
import { GitHubClient } from '../github/client.js';
import { fetchAllThreads } from './shared.js';
import type { ListComment, CommentSource } from '../github/types.js';

// ============================================================================
// Schema
// ============================================================================

export const PollInputSchema = z.object({
  owner: z.string().min(1, 'Repository owner is required'),
  repo: z.string().min(1, 'Repository name is required'),
  pr: z.number().int().positive('PR number must be positive'),
  since: z.string().datetime().optional(),
  include: z.array(z.enum(['comments', 'reviews', 'commits', 'status'])).optional()
});

export type PollInput = z.infer<typeof PollInputSchema>;

// ============================================================================
// Types
// ============================================================================

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface CheckInfo {
  context: string;
  state: 'success' | 'failure' | 'pending' | 'error';
  description: string | null;
}

export interface PollOutput {
  hasUpdates: boolean;
  cursor: string; // ISO timestamp for next poll
  since: string | null; // The timestamp we polled from
  updates: {
    newComments: ListComment[];
    resolvedThreads: string[];
    newCommits: CommitInfo[];
    checkStatus: {
      state: 'success' | 'failure' | 'pending' | null;
      total: number;
      passed: number;
      failed: number;
      pending: number;
      checks: CheckInfo[];
    } | null;
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Fetch new commits since timestamp
 */
async function fetchCommitsSince(
  owner: string,
  repo: string,
  pr: number,
  since: string | null
): Promise<CommitInfo[]> {
  try {
    const octokit = getOctokit();
    const commits = await octokit.paginate(
      octokit.pulls.listCommits,
      { owner, repo, pull_number: pr, per_page: 100 }
    );

    const sinceDate = since ? new Date(since) : null;
    const newCommits: CommitInfo[] = [];

    for (const commit of commits) {
      const commitDate = commit.commit.committer?.date;
      if (!commitDate) continue;

      if (!sinceDate || new Date(commitDate) > sinceDate) {
        newCommits.push({
          sha: commit.sha.slice(0, 7),
          message: commit.commit.message.split('\n')[0].slice(0, 80),
          author: commit.commit.author?.name || commit.author?.login || 'unknown',
          date: commitDate
        });
      }
    }

    return newCommits;
  } catch {
    return [];
  }
}

/**
 * Fetch check status for PR head
 */
async function fetchCheckStatus(
  owner: string,
  repo: string,
  pr: number
): Promise<PollOutput['updates']['checkStatus']> {
  try {
    const octokit = getOctokit();

    // Get PR head SHA
    const { data: prData } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: pr
    });

    const headSha = prData.head.sha;

    // Get combined status
    const { data: status } = await octokit.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref: headSha
    });

    const checks: CheckInfo[] = status.statuses.map(s => ({
      context: s.context,
      state: s.state as CheckInfo['state'],
      description: s.description
    }));

    return {
      state: status.state as 'success' | 'failure' | 'pending' | null,
      total: status.total_count,
      passed: checks.filter(c => c.state === 'success').length,
      failed: checks.filter(c => c.state === 'failure' || c.state === 'error').length,
      pending: checks.filter(c => c.state === 'pending').length,
      checks
    };
  } catch {
    return null;
  }
}

/**
 * Find resolved threads by comparing with previous state
 * Since we don't have previous state, we track threads resolved recently
 */
async function fetchResolvedThreadIds(
  owner: string,
  repo: string,
  pr: number,
  since: string | null,
  client: GitHubClient
): Promise<string[]> {
  if (!since) return [];

  try {
    // Fetch all threads and filter to recently resolved
    const { comments } = await fetchAllThreads(client, owner, repo, pr, { maxItems: 500 });

    // Return IDs of resolved threads
    // Note: We can't determine WHEN they were resolved without timeline API
    // So we return all resolved threads - the agent can track state externally
    return comments
      .filter(c => c.resolved)
      .map(c => c.threadId);
  } catch {
    return [];
  }
}

// ============================================================================
// Main Function
// ============================================================================

export async function prPollUpdates(
  input: PollInput,
  client: GitHubClient
): Promise<PollOutput> {
  const validated = PollInputSchema.parse(input);
  const { owner, repo, pr, since, include } = validated;

  // Default: include all update types
  const includeTypes = include || ['comments', 'reviews', 'commits', 'status'];

  const now = new Date().toISOString();

  // Parallel fetch of all update types
  const [commentsResult, commits, checkStatus, resolvedThreads] = await Promise.all([
    includeTypes.includes('comments') || includeTypes.includes('reviews')
      ? fetchAllThreads(client, owner, repo, pr, { maxItems: 100 })
      : Promise.resolve({ comments: [], cursor: null, hasMore: false }),

    includeTypes.includes('commits')
      ? fetchCommitsSince(owner, repo, pr, since || null)
      : Promise.resolve([]),

    includeTypes.includes('status')
      ? fetchCheckStatus(owner, repo, pr)
      : Promise.resolve(null),

    includeTypes.includes('reviews')
      ? fetchResolvedThreadIds(owner, repo, pr, since || null, client)
      : Promise.resolve([])
  ]);

  // Filter comments by timestamp if since is provided
  let newComments: ListComment[] = [];
  if (includeTypes.includes('comments')) {
    const sinceDate = since ? new Date(since) : null;

    newComments = commentsResult.comments
      .filter(c => {
        if (!sinceDate) return true;
        // ProcessedComment has createdAt/updatedAt
        const commentDate = c.updatedAt ? new Date(c.updatedAt) : null;
        return commentDate && commentDate > sinceDate;
      })
      .map(c => ({
        id: c.id,
        threadId: c.threadId,
        file: c.file,
        line: c.line,
        severity: c.severity,
        source: c.source,
        title: c.title,
        resolved: c.resolved,
        hasAiPrompt: c.aiPrompt !== null
      }));
  }

  const hasUpdates =
    newComments.length > 0 ||
    commits.length > 0 ||
    resolvedThreads.length > 0;

  return {
    hasUpdates,
    cursor: now,
    since: since || null,
    updates: {
      newComments,
      resolvedThreads,
      newCommits: commits,
      checkStatus
    }
  };
}
