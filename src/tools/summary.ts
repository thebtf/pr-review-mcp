/**
 * pr_summary tool - Get PR review statistics
 */

import { z } from 'zod';
import { GitHubClient } from '../github/client.js';
import { fetchAllThreads } from './shared.js';
import type { SummaryInput, SummaryOutput } from '../github/types.js';

export const SummaryInputSchema = z.object({
  owner: z.string().min(1, 'Repository owner is required'),
  repo: z.string().min(1, 'Repository name is required'),
  pr: z.number().int().positive('PR number must be positive')
});

/**
 * Get PR review summary statistics
 */
export async function prSummary(
  input: SummaryInput,
  client: GitHubClient
): Promise<SummaryOutput> {
  const validated = SummaryInputSchema.parse(input);
  const { owner, repo, pr } = validated;

  const { comments, totalCount } = await fetchAllThreads(client, owner, repo, pr, {
    maxItems: 1000
  });

  const unresolvedComments = comments.filter(c => !c.resolved);

  const bySeverity: Record<string, number> = {};
  const byFile: Record<string, number> = {};

  for (const c of unresolvedComments) {
    bySeverity[c.severity] = (bySeverity[c.severity] || 0) + 1;
    byFile[c.file] = (byFile[c.file] || 0) + 1;
  }

  return {
    pr: `${owner}/${repo}#${pr}`,
    total: totalCount,
    resolved: totalCount - unresolvedComments.length,
    unresolved: unresolvedComments.length,
    outdated: comments.filter(c => c.outdated).length,
    bySeverity,
    byFile
  };
}
