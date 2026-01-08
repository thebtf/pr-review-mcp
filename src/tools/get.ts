/**
 * pr_get tool - Get detailed comment information
 */

import { z } from 'zod';
import { GitHubClient, StructuredError } from '../github/client.js';
import { fetchAllThreads } from './shared.js';
import type { GetInput, GetOutput } from '../github/types.js';

export const GetInputSchema = z.object({
  owner: z.string().min(1, 'Repository owner is required'),
  repo: z.string().min(1, 'Repository name is required'),
  pr: z.number().int().positive('PR number must be positive'),
  id: z.string().min(1, 'Comment ID is required')
});

/**
 * Get detailed information about a specific comment
 */
export async function prGet(
  input: GetInput,
  client: GitHubClient
): Promise<GetOutput> {
  const validated = GetInputSchema.parse(input);
  const { owner, repo, pr, id } = validated;

  const { comments } = await fetchAllThreads(client, owner, repo, pr, {
    maxItems: 1000
  });

  // Find by comment ID or thread ID (with partial match support)
  const comment = comments.find(c =>
    c.id === id ||
    c.threadId === id ||
    c.id.endsWith(id) ||
    c.threadId.endsWith(id)
  );

  if (!comment) {
    throw new StructuredError('not_found', `Comment ${id} not found`, false);
  }

  return {
    id: comment.id,
    threadId: comment.threadId,
    file: comment.file,
    line: comment.line,
    severity: comment.severity,
    title: comment.title,
    body: comment.fullBody,
    aiPrompt: comment.aiPrompt ? {
      text: comment.aiPrompt,
      confidence: comment.aiPromptConfidence as 'high' | 'low'
    } : null,
    replies: comment.replies,
    canResolve: comment.canResolve
  };
}
