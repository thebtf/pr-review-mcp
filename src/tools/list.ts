/**
 * pr_list tool - List PR review comments with filtering
 */

import { z } from 'zod';
import { GitHubClient } from '../github/client.js';
import { fetchAllThreads } from './shared.js';
import { fetchQodoReview, qodoToNormalizedComments } from '../adapters/qodo.js';
import { fetchGreptileReview, greptileToNormalizedComments } from '../adapters/greptile.js';
import { getTrackerResolvedMap } from '../adapters/qodo-tracker.js';
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
 * Fetches both review threads and Qodo's persistent issue comment
 */
export async function prList(
  input: ListInput,
  client: GitHubClient
): Promise<ListOutput> {
  const validated = ListInputSchema.parse(input);
  const { owner, repo, pr, filter = {}, max = 20 } = validated;

  // Fetch review threads, Qodo/Greptile reviews, and tracker resolved status in parallel
  const [threadsResult, qodoReview, greptileReview, trackerResolved] = await Promise.all([
    fetchAllThreads(client, owner, repo, pr, { filter, maxItems: max }),
    fetchQodoReview(owner, repo, pr),
    fetchGreptileReview(owner, repo, pr),
    getTrackerResolvedMap(owner, repo, pr)
  ]);

  const { comments, totalCount, hasMore } = threadsResult;

  // Convert review thread comments
  const listComments: ListComment[] = comments.map(c => ({
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

  // Add Qodo comments if available, with resolved status from tracker
  if (qodoReview) {
    const qodoComments = qodoToNormalizedComments(qodoReview);
    for (const qc of qodoComments) {
      // Get resolved status from tracker (default to false if not tracked)
      const resolved = trackerResolved.get(qc.id) ?? false;

      // Apply filters
      if (filter.resolved !== undefined && resolved !== filter.resolved) continue;
      if (filter.file && !qc.file.includes(filter.file)) continue;

      listComments.push({
        id: qc.id,
        threadId: qc.id, // Qodo doesn't have threads
        file: qc.file,
        line: qc.line ?? '?',
        severity: qc.severity,
        source: 'qodo',
        title: qc.title,
        resolved,
        hasAiPrompt: false
      });
    }
  }

  // Add Greptile comments if available
  if (greptileReview) {
    const greptileComments = greptileToNormalizedComments(greptileReview);
    for (const gc of greptileComments) {
      // Greptile issue comments can't be resolved via API
      const resolved = false;

      // Apply filters
      if (filter.resolved !== undefined && resolved !== filter.resolved) continue;
      if (filter.file && gc.file && !gc.file.includes(filter.file)) continue;

      listComments.push({
        id: gc.id,
        threadId: gc.id, // Greptile doesn't have threads for issue comments
        file: gc.file || '',
        line: gc.line ?? '?',
        severity: gc.severity,
        source: 'greptile',
        title: gc.title,
        resolved,
        hasAiPrompt: false
      });
    }
  }

  const greptileCount = greptileReview ? greptileToNormalizedComments(greptileReview).length : 0;
  const qodoCount = qodoReview ? qodoToNormalizedComments(qodoReview).length : 0;

  return {
    comments: listComments,
    total: totalCount + qodoCount + greptileCount,
    hasMore
  };
}
