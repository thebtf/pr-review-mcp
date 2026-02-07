/**
 * pr_poll_updates tool - Stateless polling for PR review updates
 *
 * Returns new comments, resolved threads, commits, check status, and agent completion since a timestamp.
 * Enables review cycle automation without stateful monitoring.
 */

import { z } from 'zod';
import { getOctokit } from '../github/octokit.js';
import { GitHubClient } from '../github/client.js';
import { fetchAllThreads } from './shared.js';
import type { ListComment } from '../github/types.js';
import { getDefaultAgents, INVOKABLE_AGENTS, type InvokableAgentId } from '../agents/registry.js';

// ============================================================================
// Schema
// ============================================================================

export const PollInputSchema = z.object({
  owner: z.string().min(1, 'Repository owner is required'),
  repo: z.string().min(1, 'Repository name is required'),
  pr: z.number().int().positive('PR number must be positive'),
  since: z.string().datetime().optional(),
  include: z.array(z.enum(['comments', 'reviews', 'commits', 'status', 'agents'])).optional(),
  compact: z.boolean().optional().default(true)
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

export interface AgentStatus {
  agentId: InvokableAgentId;
  name: string;
  ready: boolean;
  lastComment?: string; // ISO timestamp of last comment
}

export interface AgentsStatus {
  allAgentsReady: boolean;
  agents: AgentStatus[];
}

export interface CommentsSummary {
  total: number;
  unresolved: number;
  new: number;
  bySeverity: Record<string, number>;
  bySource: Record<string, number>;
}

export interface PollOutput {
  hasUpdates: boolean;
  cursor: string; // ISO timestamp for next poll
  since: string | null; // The timestamp we polled from
  updates: {
    newComments?: ListComment[];
    commentsSummary?: CommentsSummary;
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
    agentsStatus: AgentsStatus | null;
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if an author matches an agent's pattern
 * Normalizes both author and pattern by removing [bot] suffix
 */
function matchesAuthorPattern(author: string, pattern: string | string[]): boolean {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  const normalize = (s: string) =>
    s.trim().toLowerCase().replace(/\[bot\]$/, '');
  const normAuthor = normalize(author);
  return patterns.some(p => normAuthor === normalize(p));
}

/**
 * Helper to paginate with early termination when limit is reached
 */
async function paginateWithLimit<T>(
  iterator: AsyncIterable<{ data: T[] }>,
  limit: number
): Promise<T[]> {
  const results: T[] = [];
  for await (const page of iterator) {
    results.push(...page.data);
    if (results.length >= limit) {
      return results.slice(0, limit);
    }
  }
  return results;
}

/**
 * Fetch agent completion status by checking for their comments/reviews
 * Only considers activity after the provided 'since' timestamp
 */
async function fetchAgentStatus(
  owner: string,
  repo: string,
  pr: number,
  since: string | null
): Promise<AgentsStatus> {
  const octokit = getOctokit();
  const configuredAgents = getDefaultAgents();
  const sinceDate = since ? new Date(since) : null;

  // Get issue comments and reviews to check for agent activity
  // Use iterator-based pagination with early termination
  const [issueComments, reviews] = await Promise.all([
    paginateWithLimit(
      octokit.paginate.iterator(octokit.issues.listComments, {
        owner,
        repo,
        issue_number: pr,
        per_page: 100
      }),
      200
    ),
    paginateWithLimit(
      octokit.paginate.iterator(octokit.pulls.listReviews, {
        owner,
        repo,
        pull_number: pr,
        per_page: 100
      }),
      100
    )
  ]);

  const agentStatuses: AgentStatus[] = configuredAgents.map(agentId => {
    const config = INVOKABLE_AGENTS[agentId];
    if (!config) {
      // Safety guard for runtime consistency
      return {
        agentId,
        name: agentId,
        ready: false
      };
    }

    const pattern = config.authorPattern;

    // Filter comments by author and timestamp
    const agentIssueComments = issueComments.filter(c =>
      c.user &&
      matchesAuthorPattern(c.user.login, pattern) &&
      (!sinceDate || new Date(c.created_at) > sinceDate)
    );

    // Filter reviews by author and timestamp
    const agentReviews = reviews.filter(r =>
      r.user &&
      matchesAuthorPattern(r.user.login, pattern) &&
      r.submitted_at !== null &&
      r.submitted_at !== undefined &&
      (!sinceDate || new Date(r.submitted_at) > sinceDate)
    );

    const hasActivity = agentIssueComments.length > 0 || agentReviews.length > 0;

    // Find latest timestamp from filtered activity
    let lastComment: string | undefined;
    const allDates = [
      ...agentIssueComments.map(c => c.created_at),
      ...agentReviews.map(r => r.submitted_at).filter((d): d is string => d !== null && d !== undefined)
    ];
    if (allDates.length > 0) {
      const timestamps = allDates.map(d => new Date(d).getTime());
      lastComment = new Date(Math.max(...timestamps)).toISOString();
    }

    return {
      agentId,
      name: config.name,
      ready: hasActivity,
      lastComment
    };
  });

  const allAgentsReady = agentStatuses.every(a => a.ready);

  return {
    allAgentsReady,
    agents: agentStatuses
  };
}

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
 * Find resolved threads
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
    const { comments } = await fetchAllThreads(client, owner, repo, pr, { maxItems: 500 });
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
  const { owner, repo, pr, since, include, compact } = validated;

  // Default: include all update types except agents
  const includeTypes = include || ['comments', 'reviews', 'commits', 'status'];

  const now = new Date().toISOString();

  // Fetch resolved threads and comments in a single call to avoid duplicate API requests
  let resolvedThreads: string[] = [];
  let commentsResult: { comments: import('../github/types.js').ProcessedComment[]; cursor: string | null; hasMore: boolean } = {
    comments: [],
    cursor: null,
    hasMore: false
  };

  if (includeTypes.includes('comments') || includeTypes.includes('reviews')) {
    commentsResult = await fetchAllThreads(client, owner, repo, pr, { maxItems: 500 });

    // Extract resolved threads if reviews are included
    if (includeTypes.includes('reviews')) {
      resolvedThreads = commentsResult.comments
        .filter(c => c.resolved)
        .map(c => c.threadId);
    }
  }

  // Parallel fetch of other update types
  const [commits, checkStatus, agentsStatus] = await Promise.all([
    includeTypes.includes('commits')
      ? fetchCommitsSince(owner, repo, pr, since || null)
      : Promise.resolve([]),

    includeTypes.includes('status')
      ? fetchCheckStatus(owner, repo, pr)
      : Promise.resolve(null),

    includeTypes.includes('agents')
      ? fetchAgentStatus(owner, repo, pr, since || null)
      : Promise.resolve(null)
  ]);

  // Filter comments by timestamp if since is provided
  let newComments: ListComment[] | undefined;
  let commentsSummary: CommentsSummary | undefined;
  let newCommentCount = 0;

  if (includeTypes.includes('comments')) {
    const sinceDate = since ? new Date(since) : null;

    const filteredComments = commentsResult.comments.filter(c => {
      if (!sinceDate) return true;
      const commentDate = c.createdAt ? new Date(c.createdAt) : null;
      return commentDate && commentDate > sinceDate;
    });

    newCommentCount = filteredComments.length;

    if (compact) {
      // Compact mode: return summary instead of full comment list
      const allComments = commentsResult.comments;
      let unresolved = 0;
      const bySeverity: Record<string, number> = {};
      const bySource: Record<string, number> = {};

      for (const c of allComments) {
        if (!c.resolved) {
          unresolved++;
          const sev = c.severity ?? 'unknown';
          bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
          const src = c.source ?? 'unknown';
          bySource[src] = (bySource[src] ?? 0) + 1;
        }
      }

      commentsSummary = {
        total: allComments.length,
        unresolved,
        new: newCommentCount,
        bySeverity,
        bySource
      };
    } else {
      // Full mode: return complete comment list (legacy behavior)
      newComments = filteredComments.map(c => ({
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
  }

  // Determine if there are updates including agent activity
  const hasAgentUpdates = agentsStatus?.agents?.some(a => a.ready) ?? false;

  const hasUpdates =
    newCommentCount > 0 ||
    commits.length > 0 ||
    resolvedThreads.length > 0 ||
    hasAgentUpdates;

  return {
    hasUpdates,
    cursor: now,
    since: since || null,
    updates: {
      ...(includeTypes.includes('comments')
        ? compact
          ? { commentsSummary }
          : { newComments: newComments ?? [] }
        : {}
      ),
      resolvedThreads,
      newCommits: commits,
      checkStatus,
      agentsStatus
    }
  };
}
