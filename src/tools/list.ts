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
import { classifyFinding } from '../review/classify-unresolved.js';

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

export const ListOutputSchema = z.object({
  comments: z.array(z.object({
    id: z.string(),
    threadId: z.string(),
    file: z.string(),
    line: z.union([z.number(), z.string()]),
    severity: z.string(),
    source: z.string(),
    title: z.string(),
    resolved: z.boolean(),
    hasAiPrompt: z.boolean(),
    // Classification fields — optional for backward compatibility
    actionClass: z.string().optional(),
    blocksMerge: z.boolean().optional(),
    classificationReason: z.string().optional(),
    residualKind: z.string().optional(),
  })),
  total: z.number(),
  hasMore: z.boolean(),
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

  // Convert review thread comments with per-finding classification
  const listComments: ListComment[] = comments.map(c => {
    const classification = !c.resolved
      ? classifyFinding({
          threadId: c.threadId,
          outdated: c.outdated ?? false,
          resolved: c.resolved ?? false,
          severity: c.severity,
          source: c.source,
        })
      : undefined;

    return {
      id: c.id,
      threadId: c.threadId,
      file: c.file,
      line: c.line,
      severity: c.severity,
      source: c.source,
      title: c.title,
      resolved: c.resolved,
      hasAiPrompt: c.aiPrompt !== null,
      ...(classification
        ? {
            actionClass: classification.actionClass,
            blocksMerge: classification.blocksMerge,
            classificationReason: classification.classificationReason,
            ...(classification.residualKind !== undefined
              ? { residualKind: classification.residualKind }
              : {}),
          }
        : {}),
    };
  });

  // Compute Qodo and Greptile comments once
  const qodoComments = qodoReview ? qodoToNormalizedComments(qodoReview) : [];
  const greptileComments = greptileReview ? greptileToNormalizedComments(greptileReview) : [];

  // Add Qodo comments if available, with resolved status from tracker
  for (const qc of qodoComments) {
    // Get resolved status from tracker (default to false if not tracked)
    const resolved = trackerResolved.get(qc.id) ?? false;

    // Apply filters
    if (filter.resolved !== undefined && resolved !== filter.resolved) continue;
    if (filter.file && !qc.file.includes(filter.file)) continue;

    const classification = !resolved
      ? classifyFinding({
          threadId: qc.id,
          outdated: false,
          resolved,
          severity: qc.severity,
          source: 'qodo',
        })
      : undefined;

    listComments.push({
      id: qc.id,
      threadId: qc.id,
      file: qc.file,
      line: qc.line ?? '?',
      severity: qc.severity,
      source: 'qodo',
      title: qc.title,
      resolved,
      hasAiPrompt: false,
      ...(classification
        ? {
            actionClass: classification.actionClass,
            blocksMerge: classification.blocksMerge,
            classificationReason: classification.classificationReason,
            ...(classification.residualKind !== undefined
              ? { residualKind: classification.residualKind }
              : {}),
          }
        : {}),
    });
  }

  // Add Greptile comments if available
  for (const gc of greptileComments) {
    // Greptile issue comments can't be resolved via API
    const resolved = false;

    // Apply filters
    if (filter.resolved !== undefined && resolved !== filter.resolved) continue;
    if (filter.file && gc.file && !gc.file.includes(filter.file)) continue;

    const classification = classifyFinding({
      threadId: gc.id,
      outdated: false,
      resolved,
      severity: gc.severity,
      source: 'greptile',
    });

    listComments.push({
      id: gc.id,
      threadId: gc.id,
      file: gc.file || '',
      line: gc.line ?? '?',
      severity: gc.severity,
      source: 'greptile',
      title: gc.title,
      resolved,
      hasAiPrompt: false,
      actionClass: classification.actionClass,
      blocksMerge: classification.blocksMerge,
      classificationReason: classification.classificationReason,
      ...(classification.residualKind !== undefined
        ? { residualKind: classification.residualKind }
        : {}),
    });
  }

  const greptileCount = greptileComments.length;
  const qodoCount = qodoComments.length;

  return {
    comments: listComments,
    total: totalCount + qodoCount + greptileCount,
    hasMore
  };
}
