/**
 * pr_resolve tool - Resolve a review thread
 */

import { z } from 'zod';
import { GitHubClient, StructuredError } from '../github/client.js';
import { QUERIES } from '../github/queries.js';
import { fetchAllThreads } from './shared.js';
import type { ResolveInput, ResolveOutput, ResolveThreadData } from '../github/types.js';

export const ResolveInputSchema = z.object({
  owner: z.string().min(1, 'Repository owner is required'),
  repo: z.string().min(1, 'Repository name is required'),
  threadId: z.string().min(1, 'Thread ID is required')
});

/**
 * Resolve a review thread
 */
export async function prResolve(
  input: ResolveInput,
  client: GitHubClient
): Promise<ResolveOutput> {
  const validated = ResolveInputSchema.parse(input);
  const { owner, repo, threadId } = validated;

  // Find the thread to get PR number and verify it exists
  // We need to search for the thread - this is a limitation of the API
  // For now, we'll trust the threadId is valid and attempt the mutation

  // Attempt to resolve
  const clientMutationId = `resolve-${threadId}-${Date.now()}`;

  try {
    await client.graphql<ResolveThreadData>(QUERIES.resolveThread, {
      threadId,
      clientMutationId
    });

    return {
      success: true,
      threadId,
      file: 'unknown', // We don't have this info without fetching
      title: 'Thread resolved'
    };
  } catch (e) {
    if (e instanceof StructuredError) {
      // Already resolved is still success
      if (e.message.includes('already resolved')) {
        return {
          success: true,
          threadId,
          file: 'unknown',
          title: 'Thread was already resolved'
        };
      }
      throw e;
    }
    throw new StructuredError(
      'network',
      `Failed to resolve thread: ${e instanceof Error ? e.message : String(e)}`,
      true
    );
  }
}

/**
 * Resolve with context (fetches thread info first)
 */
export async function prResolveWithContext(
  input: ResolveInput & { pr: number },
  client: GitHubClient
): Promise<ResolveOutput> {
  const { owner, repo, pr, threadId } = input;

  // Find the thread first
  const { comments } = await fetchAllThreads(client, owner, repo, pr, {
    maxItems: 1000
  });

  const comment = comments.find(c =>
    c.threadId === threadId || c.threadId.endsWith(threadId)
  );

  if (!comment) {
    throw new StructuredError('not_found', `Thread ${threadId} not found`, false);
  }

  if (comment.resolved) {
    return {
      success: true,
      threadId: comment.threadId,
      file: comment.file,
      title: 'Thread was already resolved'
    };
  }

  if (!comment.canResolve) {
    throw new StructuredError(
      'permission',
      'You cannot resolve this thread - check permissions',
      false
    );
  }

  // Execute resolve mutation
  const clientMutationId = `resolve-${comment.threadId}-${Date.now()}`;
  await client.graphql<ResolveThreadData>(QUERIES.resolveThread, {
    threadId: comment.threadId,
    clientMutationId
  });

  return {
    success: true,
    threadId: comment.threadId,
    file: comment.file,
    title: comment.title
  };
}
