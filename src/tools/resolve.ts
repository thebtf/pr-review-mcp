/**
 * pr_resolve tool - Resolve a review thread or Qodo issue
 */

import { z } from 'zod';
import { GitHubClient, StructuredError } from '../github/client.js';
import { QUERIES } from '../github/queries.js';
import { fetchAllThreads } from './shared.js';
import { fetchQodoReview } from '../adapters/qodo.js';
import { toggleQodoIssue } from '../adapters/qodo-tracker.js';
import { stateManager } from '../coordination/state.js';
import { addResolvedReaction, addReactionToNode } from '../github/state-comment.js';
import { logger } from '../logging.js';
import type { ResolveInput, ResolveOutput, ResolveThreadData } from '../github/types.js';

export const ResolveInputSchema = z.object({
  owner: z.string().min(1, 'Repository owner is required'),
  repo: z.string().min(1, 'Repository name is required'),
  pr: z.number().int().positive('PR number must be positive'),
  threadId: z.string().min(1, 'Thread ID is required')
});

/**
 * Resolve with context (fetches thread info first)
 * Supports both review threads and Qodo issues
 */
export async function prResolveWithContext(
  input: ResolveInput & { pr: number },
  client: GitHubClient
): Promise<ResolveOutput> {
  const { owner, repo, pr } = input;
  let { threadId } = input;

  // Check if this is a Qodo issue ID
  if (threadId.startsWith('qodo-')) {
    return resolveQodoIssue(owner, repo, pr, threadId);
  }

  // Check if this is a child issue of a multi-issue comment
  const parentId = await stateManager.getParentIdForChild(threadId, { owner, repo, pr });
  if (parentId) {
    await stateManager.markChildResolved(threadId, { owner, repo, pr });

    // Try to add visual indicator reaction to parent comment
    try {
      if (parentId.startsWith('qodo-')) {
        // Qodo: extract numeric comment ID from format qodo-{owner}-{repo}-{pr}-{commentId}
        const parts = parentId.split('-');
        const lastPart = parts[parts.length - 1];
        const numericId = parseInt(lastPart, 10);
        if (!isNaN(numericId)) {
          await addResolvedReaction(owner, repo, numericId, '+1');
          logger.debug('[resolve] Added reaction to Qodo comment', { parentId, numericId });
        }
      } else if (parentId.startsWith('PRRC_') || parentId.startsWith('PRR_') || parentId.startsWith('PRRT_')) {
        // GraphQL node ID (review comment, review, or thread) - use GraphQL API
        await addReactionToNode(parentId, '+1');
        logger.debug('[resolve] Added reaction to review comment via GraphQL', { parentId });
      } else if (parentId.startsWith('coderabbit-')) {
        // Synthetic nitpick - no real GitHub entity to react to
        logger.debug('[resolve] Skipping reaction for synthetic comment', { parentId });
      } else {
        // Try GraphQL for unknown node types (may be a node ID)
        await addReactionToNode(parentId, '+1');
        logger.debug('[resolve] Added reaction via GraphQL (unknown type)', { parentId });
      }
    } catch (err) {
      // Reaction is optional, don't fail the resolve
      logger.debug('[resolve] Failed to add reaction to parent (optional)', { parentId, error: err });
    }

    const allResolved = await stateManager.areAllChildrenResolved(parentId, { owner, repo, pr });
    if (!allResolved) {
      return {
        success: true,
        synthetic: true,
        threadId,
        message: 'Child issue resolved. Parent issue remains open until all children are resolved.'
      };
    }

    // All children resolved - proceed to resolve the parent
    // We switch the target threadId to the parentId so the subsequent logic handles the parent
    // eslint-disable-next-line no-param-reassign
    threadId = parentId;
  }

  // Handle synthetic CodeRabbit comments (nitpicks and outside-diff)
  if (threadId.startsWith('coderabbit-nitpick-') || threadId.startsWith('coderabbit-outside-diff-')) {
    await stateManager.markNitpickResolved(threadId, 'agent', { owner, repo, pr });
    return { success: true, synthetic: true, message: 'Synthetic comment marked as resolved internally' };
  }

  // Find the thread first
  const { comments } = await fetchAllThreads(client, owner, repo, pr, {
    maxItems: 1000
  });

  // Match exact ID or suffix after separator (prevents false positives)
  const comment = comments.find(c =>
    c.threadId === threadId ||
    c.threadId.endsWith(`_${threadId}`) ||
    c.threadId.endsWith(`-${threadId}`)
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

/**
 * Resolve a Qodo issue via tracker comment
 */
async function resolveQodoIssue(
  owner: string,
  repo: string,
  pr: number,
  issueId: string
): Promise<ResolveOutput> {
  // Fetch Qodo review
  const qodoReview = await fetchQodoReview(owner, repo, pr);

  if (!qodoReview) {
    throw new StructuredError('not_found', 'No Qodo review found for this PR', false);
  }

  // Toggle the issue to resolved
  const state = await toggleQodoIssue(owner, repo, pr, qodoReview, issueId, true);

  // Find the resolved item for response
  const item = state.items.find(i => i.id === issueId || i.id.endsWith(issueId));

  return {
    success: true,
    threadId: issueId,
    file: item?.file || '',
    title: item?.title || 'Qodo issue resolved'
  };
}
