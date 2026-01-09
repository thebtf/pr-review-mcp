/**
 * pr_get tool - Get detailed comment information
 */

import { z } from 'zod';
import { GitHubClient, StructuredError } from '../github/client.js';
import { fetchAllThreads } from './shared.js';
import { fetchQodoReview, qodoToNormalizedComments } from '../adapters/qodo.js';
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

  // Fetch both review threads and Qodo comments in parallel
  const [threadsResult, qodoReview] = await Promise.all([
    fetchAllThreads(client, owner, repo, pr, { maxItems: 1000 }),
    fetchQodoReview(owner, repo, pr)
  ]);

  const { comments } = threadsResult;

  // Find by comment ID or thread ID (with partial match support)
  let comment = comments.find(c =>
    c.id === id ||
    c.threadId === id ||
    c.id.endsWith(id) ||
    c.threadId.endsWith(id)
  );

  // If not found in review threads, check Qodo comments
  if (!comment && qodoReview) {
    const qodoComments = qodoToNormalizedComments(qodoReview);
    const qodoComment = qodoComments.find(qc =>
      qc.id === id || qc.id.endsWith(id)
    );

    if (qodoComment) {
      // Return Qodo comment in GetOutput format
      return {
        id: qodoComment.id,
        threadId: qodoComment.id, // Qodo doesn't have threads
        file: qodoComment.file,
        line: qodoComment.line ?? '?',
        severity: qodoComment.severity,
        source: 'qodo',
        title: qodoComment.title,
        body: qodoComment.body,
        aiPrompt: null,
        replies: [],
        canResolve: false // Qodo comments can't be resolved via API
      };
    }
  }

  if (!comment) {
    throw new StructuredError('not_found', `Comment ${id} not found`, false);
  }

  return {
    id: comment.id,
    threadId: comment.threadId,
    file: comment.file,
    line: comment.line,
    severity: comment.severity,
    source: comment.source,
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
