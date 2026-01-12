/**
 * pr_list_prs tool - List all pull requests in a repository
 */

import { z } from 'zod';
import { GitHubClient } from '../github/client.js';
import { QUERIES } from '../github/queries.js';

export const ListPRsInputSchema = z.object({
  owner: z.string().min(1, 'Repository owner is required'),
  repo: z.string().min(1, 'Repository name is required'),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED', 'all']).optional().default('OPEN'),
  limit: z.number().int().min(1).max(100).optional().default(20)
});

export type ListPRsInput = z.infer<typeof ListPRsInputSchema>;

interface PRNode {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  author: { login: string } | null;
  baseRefName: string;
  headRefName: string;
  mergeable: string;
  reviewDecision: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewThreads: { totalCount: number };
  comments: { totalCount: number };
}

interface ListPRsResponse {
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      totalCount: number;
      nodes: PRNode[];
    };
  };
}

export interface PRInfo {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  author: string;
  branch: string;
  baseBranch: string;
  mergeable: string;
  reviewDecision: string | null;
  stats: {
    additions: number;
    deletions: number;
    changedFiles: number;
    reviewThreads: number;
    comments: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ListPRsOutput {
  repo: string;
  total: number;
  returned: number;
  state: string;
  pullRequests: PRInfo[];
}

/**
 * List all pull requests in a repository
 */
export async function prListPRs(
  input: ListPRsInput,
  client: GitHubClient
): Promise<ListPRsOutput> {
  const validated = ListPRsInputSchema.parse(input);
  const { owner, repo, state, limit } = validated;

  // Map state to GraphQL enum values
  const states = state === 'all'
    ? ['OPEN', 'CLOSED', 'MERGED']
    : [state];

  const response = await client.graphql<ListPRsResponse>(
    QUERIES.listPullRequests,
    {
      owner,
      repo,
      states,
      first: limit,
      cursor: null
    }
  );

  const prData = response.repository.pullRequests;

  const pullRequests: PRInfo[] = prData.nodes.map(pr => ({
    number: pr.number,
    title: pr.title,
    state: pr.state,
    isDraft: pr.isDraft,
    author: pr.author?.login || 'unknown',
    branch: pr.headRefName,
    baseBranch: pr.baseRefName,
    mergeable: pr.mergeable,
    reviewDecision: pr.reviewDecision,
    stats: {
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      reviewThreads: pr.reviewThreads.totalCount,
      comments: pr.comments.totalCount
    },
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt
  }));

  return {
    repo: `${owner}/${repo}`,
    total: prData.totalCount,
    returned: pullRequests.length,
    state,
    pullRequests
  };
}
