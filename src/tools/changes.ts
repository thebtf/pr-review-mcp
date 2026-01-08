/**
 * pr_changes tool - Get comments since cursor (incremental fetch)
 */

import { z } from 'zod';
import { GitHubClient } from '../github/client.js';
import { fetchAllThreads } from './shared.js';
import type { ChangesInput, ChangesOutput, ListComment } from '../github/types.js';

export const ChangesInputSchema = z.object({
  owner: z.string().min(1, 'Repository owner is required'),
  repo: z.string().min(1, 'Repository name is required'),
  pr: z.number().int().positive('PR number must be positive'),
  cursor: z.string().optional(),
  max: z.number().int().positive().max(100).default(50)
});

/**
 * Get comments since cursor for incremental updates
 */
export async function prChanges(
  input: ChangesInput,
  client: GitHubClient
): Promise<ChangesOutput> {
  const validated = ChangesInputSchema.parse(input);
  const { owner, repo, pr, cursor, max = 50 } = validated;

  try {
    const { comments, cursor: nextCursor, totalCount } = await fetchAllThreads(
      client,
      owner,
      repo,
      pr,
      {
        startCursor: cursor,
        maxItems: max
      }
    );

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
      cursor: nextCursor,
      hasMore: comments.length < totalCount
    };
  } catch (e) {
    // If cursor is invalid, fetch from beginning
    if (e instanceof Error && (e.message.includes('cursor') || e.message.includes('invalid'))) {
      console.warn('Cursor invalid, fetching from beginning');
      return prChanges({ ...input, cursor: undefined }, client);
    }
    throw e;
  }
}
