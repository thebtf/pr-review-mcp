/**
 * pr_reviewers tool - Manage PR reviewers
 *
 * Request or remove reviewers from a pull request.
 */

import { z } from 'zod';
import { getOctokit } from '../github/octokit.js';
import { StructuredError } from '../github/client.js';

// ============================================================================
// Schema
// ============================================================================

export const ReviewersInputSchema = z.object({
  owner: z.string().min(1, 'Repository owner is required'),
  repo: z.string().min(1, 'Repository name is required'),
  pr: z.number().int().positive('PR number must be positive'),
  action: z.enum(['request', 'remove']),
  reviewers: z.array(z.string().min(1)).default([]),
  team_reviewers: z.array(z.string().min(1)).default([])
}).refine(
  data => data.reviewers.length > 0 || data.team_reviewers.length > 0,
  { message: 'At least one reviewer or team_reviewer is required' }
);

export type ReviewersInput = z.infer<typeof ReviewersInputSchema>;

// ============================================================================
// Types
// ============================================================================

export interface ReviewersOutput {
  success: boolean;
  action: 'request' | 'remove';
  requested_reviewers: string[];
  requested_teams: string[];
}

// ============================================================================
// Main Function
// ============================================================================

export async function prReviewers(input: ReviewersInput): Promise<ReviewersOutput> {
  const validated = ReviewersInputSchema.parse(input);
  const { owner, repo, pr, action, reviewers, team_reviewers } = validated;

  const octokit = getOctokit();

  try {
    switch (action) {
      case 'request': {
        const { data } = await octokit.pulls.requestReviewers({
          owner,
          repo,
          pull_number: pr,
          reviewers: reviewers.length > 0 ? reviewers : undefined,
          team_reviewers: team_reviewers.length > 0 ? team_reviewers : undefined
        });

        return {
          success: true,
          action: 'request',
          requested_reviewers: data.requested_reviewers?.map(r => r.login) || [],
          requested_teams: data.requested_teams?.map(t => t.slug) || []
        };
      }

      case 'remove': {
        await octokit.pulls.removeRequestedReviewers({
          owner,
          repo,
          pull_number: pr,
          reviewers,
          team_reviewers
        });

        // Get current requested reviewers
        const { data: prData } = await octokit.pulls.get({
          owner,
          repo,
          pull_number: pr
        });

        return {
          success: true,
          action: 'remove',
          requested_reviewers: prData.requested_reviewers?.map(r => r.login) || [],
          requested_teams: prData.requested_teams?.map(t => t.slug) || []
        };
      }
    }
  } catch (e) {
    if (e && typeof e === 'object' && 'status' in e) {
      const status = (e as { status: number }).status;
      const message = (e as { message?: string }).message || 'Unknown error';

      if (status === 404) {
        throw new StructuredError('not_found', `PR #${pr} not found`, false);
      }
      if (status === 403) {
        throw new StructuredError('permission', `No permission to modify reviewers: ${message}`, false);
      }
      if (status === 422) {
        // Common: user is not a collaborator or already reviewed
        throw new StructuredError(
          'parse',
          `Cannot ${action} reviewer: ${message}`,
          false,
          'Check that users are collaborators and haven\'t already submitted a review'
        );
      }

      throw new StructuredError('network', `GitHub API error: ${message}`, true);
    }

    throw new StructuredError(
      'network',
      `Failed to ${action} reviewers: ${e instanceof Error ? e.message : String(e)}`,
      true
    );
  }
}
