/**
 * pr_list tool - List PR review comments with filtering
 */

import { z } from 'zod';
import { GitHubClient } from '../github/client.js';
import { fetchAllThreads } from './shared.js';
import type { ListInput, ListOutput, ListComment } from '../github/types.js';

export const ListInputSchema = z.object({
  owner: z.string().min(1, 'Repository owner is required'),
  repo: z.string().min(1, 'Repository name is required'),
  pr: z.number().int().positive('PR number must be positive'),
  filter: z.object({
    resolved: z.boolean().optional(),
    outdated: z.boolean().optional(),
    file: z.string().optional(),
    author: z.string().optional()
  }).optional(),
  max: z.number().int().positive().max(100).default(20)
});

/**
 * List PR review comments with optional filtering
 */
export async function prList(
  input: ListInput,
  client: GitHubClient
): Promise<ListOutput> {
  const validated = ListInputSchema.parse(input);
  const { owner, repo, pr, filter = {}, max = 20 } = validated;

  const { comments, totalCount, hasMore } = await fetchAllThreads(client, owner, repo, pr, {
    filter,
    maxItems: max
  });

  const listComments: ListComment[] = comments.map(c => ({
    id: c.id,
    threadId: c.threadId,
    file: c.file,
    line: c.line,
    severity: c.severity,
    title: c.title,
    resolved: c.resolved,
    hasAiPrompt: c.aiPrompt !== null
  }));

  return {
    comments: listComments,
    total: totalCount,
    hasMore
  };
}
