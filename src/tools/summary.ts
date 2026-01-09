/**
 * pr_summary tool - Get PR review statistics
 */

import { z } from 'zod';
import { GitHubClient } from '../github/client.js';
import { fetchAllThreads } from './shared.js';
import { fetchQodoReview, qodoToNormalizedComments } from '../adapters/qodo.js';
import { getTrackerResolvedMap } from '../adapters/qodo-tracker.js';
import type { SummaryInput, SummaryOutput } from '../github/types.js';

export const SummaryInputSchema = z.object({
  owner: z.string().min(1, 'Repository owner is required'),
  repo: z.string().min(1, 'Repository name is required'),
  pr: z.number().int().positive('PR number must be positive')
});

/**
 * Get PR review summary statistics
 * Includes both review threads and Qodo's persistent issue comment
 */
export async function prSummary(
  input: SummaryInput,
  client: GitHubClient
): Promise<SummaryOutput> {
  const validated = SummaryInputSchema.parse(input);
  const { owner, repo, pr } = validated;

  // Fetch review threads, Qodo review, and tracker resolved status in parallel
  const [threadsResult, qodoReview, trackerResolved] = await Promise.all([
    fetchAllThreads(client, owner, repo, pr, { maxItems: 1000 }),
    fetchQodoReview(owner, repo, pr),
    getTrackerResolvedMap(owner, repo, pr)
  ]);

  const { comments, totalCount } = threadsResult;

  // Get Qodo comments with resolved status from tracker
  const qodoComments = qodoReview ? qodoToNormalizedComments(qodoReview) : [];
  const qodoCount = qodoComments.length;

  // Apply tracker resolved status to Qodo comments
  const unresolvedQodo = qodoComments.filter(qc => {
    const resolved = trackerResolved.get(qc.id) ?? false;
    return !resolved;
  });

  const resolvedQodoCount = qodoComments.filter(qc =>
    trackerResolved.get(qc.id) ?? false
  ).length;

  // Combine all comments for stats
  const allUnresolved = [
    ...comments.filter(c => !c.resolved),
    ...unresolvedQodo
  ];

  const bySeverity: Record<string, number> = {};
  const byFile: Record<string, number> = {};

  for (const c of allUnresolved) {
    const severity = 'severity' in c ? c.severity : 'N/A';
    const file = c.file || 'general';
    bySeverity[severity] = (bySeverity[severity] || 0) + 1;
    byFile[file] = (byFile[file] || 0) + 1;
  }

  return {
    pr: `${owner}/${repo}#${pr}`,
    total: totalCount + qodoCount,
    resolved: comments.filter(c => c.resolved).length + resolvedQodoCount,
    unresolved: allUnresolved.length,
    outdated: comments.filter(c => c.outdated).length,
    bySeverity,
    byFile
  };
}
