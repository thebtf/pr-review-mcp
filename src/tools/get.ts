/**
 * pr_get tool - Get detailed comment information
 */

import { z } from 'zod';
import { GitHubClient, StructuredError } from '../github/client.js';
import { fetchAllThreads } from './shared.js';
import { fetchQodoReview, qodoToNormalizedComments } from '../adapters/qodo.js';
import { fetchGreptileReview, greptileToNormalizedComments } from '../adapters/greptile.js';
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

  // Fetch review threads, Qodo, and Greptile comments in parallel
  const [threadsResult, qodoReview, greptileReview] = await Promise.all([
    fetchAllThreads(client, owner, repo, pr, { maxItems: 1000 }),
    fetchQodoReview(owner, repo, pr),
    fetchGreptileReview(owner, repo, pr)
  ]);

  const { comments } = threadsResult;

  // Find by comment ID or thread ID (exact match first, then partial)
  let comment = comments.find(c => c.id === id || c.threadId === id);

  // If no exact match, try suffix match (ensure uniqueness)
  if (!comment) {
    const suffixMatches = comments.filter(c =>
      c.id.endsWith(id) || c.threadId.endsWith(id)
    );
    if (suffixMatches.length === 1) {
      comment = suffixMatches[0];
    } else if (suffixMatches.length > 1) {
      throw new StructuredError(
        'parse',
        `ID "${id}" matches multiple comments. Use full ID for exact match.`,
        false
      );
    }
  }

  // If not found in review threads, check Qodo comments
  if (!comment && qodoReview) {
    const qodoComments = qodoToNormalizedComments(qodoReview);
    // Try exact match first
    let qodoComment = qodoComments.find(qc => qc.id === id);

    // If no exact match, try suffix match (ensure uniqueness)
    if (!qodoComment) {
      const qodoSuffixMatches = qodoComments.filter(qc => qc.id.endsWith(id));
      if (qodoSuffixMatches.length === 1) {
        qodoComment = qodoSuffixMatches[0];
      } else if (qodoSuffixMatches.length > 1) {
        throw new StructuredError(
          'parse',
          `ID "${id}" matches multiple Qodo comments. Use full ID for exact match.`,
          false
        );
      }
    }

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

  // If not found, check Greptile comments
  if (!comment && greptileReview) {
    const greptileComments = greptileToNormalizedComments(greptileReview);
    // Try exact match first
    let greptileComment = greptileComments.find(gc => gc.id === id);

    // If no exact match, try suffix match (ensure uniqueness)
    if (!greptileComment) {
      const greptileSuffixMatches = greptileComments.filter(gc => gc.id.endsWith(id));
      if (greptileSuffixMatches.length === 1) {
        greptileComment = greptileSuffixMatches[0];
      } else if (greptileSuffixMatches.length > 1) {
        throw new StructuredError(
          'parse',
          `ID "${id}" matches multiple Greptile comments. Use full ID for exact match.`,
          false
        );
      }
    }

    if (greptileComment) {
      // Return Greptile comment in GetOutput format
      return {
        id: greptileComment.id,
        threadId: greptileComment.id, // Greptile issue comments don't have threads
        file: greptileComment.file || '',
        line: greptileComment.line ?? '?',
        severity: greptileComment.severity,
        source: 'greptile',
        title: greptileComment.title,
        body: greptileComment.body,
        aiPrompt: null,
        replies: [],
        canResolve: false // Greptile issue comments can't be resolved via API
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
