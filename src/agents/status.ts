import { getOctokit } from '../github/octokit.js';
import { getDefaultAgents, INVOKABLE_AGENTS, type InvokableAgentId } from './registry.js';

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

/**
 * Check if an author matches an agent's pattern
 * Normalizes both author and pattern by removing [bot] suffix
 */
export function matchesAuthorPattern(author: string, pattern: string | string[]): boolean {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  const normalize = (s: string) =>
    s.trim().toLowerCase().replace(/\[bot\]$/, '');
  const normAuthor = normalize(author);
  return patterns.some(p => normAuthor === normalize(p));
}

/**
 * Helper to paginate with early termination when limit is reached
 */
export async function paginateWithLimit<T>(
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
 * Fetch agent completion status for configured default agents.
 * Delegates to fetchAgentStatusForAgents with getDefaultAgents().
 */
export async function fetchAgentStatus(
  owner: string,
  repo: string,
  pr: number,
  since: string | null
): Promise<AgentsStatus> {
  return fetchAgentStatusForAgents(owner, repo, pr, getDefaultAgents(), since);
}

export async function fetchAgentStatusForAgents(
  owner: string,
  repo: string,
  pr: number,
  agents: InvokableAgentId[],
  since: string | null
): Promise<AgentsStatus> {
  const octokit = getOctokit();
  const sinceDate = since ? new Date(since) : null;

  // Get issue comments and reviews to check for agent activity
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

  const agentStatuses: AgentStatus[] = agents.map(agentId => {
    const config = INVOKABLE_AGENTS[agentId];
    if (!config) {
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
      (!sinceDate || new Date(c.updated_at ?? c.created_at) > sinceDate)
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
      ...agentIssueComments.map(c => c.updated_at ?? c.created_at),
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
