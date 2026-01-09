/**
 * pr_summary tool - Get PR review statistics
 */

import { z } from 'zod';
import { GitHubClient } from '../github/client.js';
import { fetchAllThreads } from './shared.js';
import { fetchQodoReview, qodoToNormalizedComments } from '../adapters/qodo.js';
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

  // Fetch review threads and Qodo review in parallel
  const [threadsResult, qodoReview] = await Promise.all([
    fetchAllThreads(client, owner, repo, pr, { maxItems: 1000 }),
    fetchQodoReview(owner, repo, pr)
  ]);

  const { comments, totalCount } = threadsResult;

  // Get Qodo comments (always unresolved)
  const qodoComments = qodoReview ? qodoToNormalizedComments(qodoReview) : [];
  const qodoCount = qodoComments.length;

  // Combine all comments for stats
  const allUnresolved = [
    ...comments.filter(c => !c.resolved),
    ...qodoComments // Qodo comments are always unresolved
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
    resolved: comments.filter(c => c.resolved).length,
    unresolved: allUnresolved.length,
    outdated: comments.filter(c => c.outdated).length,
    bySeverity,
    byFile
  };
}
