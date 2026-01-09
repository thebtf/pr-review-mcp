/**
 * pr_merge tool - Merge a pull request
 *
 * Merges a PR using the specified method (merge, squash, rebase).
 * Optionally deletes the head branch after merge.
 *
 * CAUTION: This is a destructive operation. Ensure the PR is ready to merge.
 */

import { z } from 'zod';
import { getOctokit } from '../github/octokit.js';
import { StructuredError } from '../github/client.js';

// ============================================================================
// Schema
// ============================================================================

export const MergeInputSchema = z.object({
  owner: z.string().min(1, 'Repository owner is required'),
  repo: z.string().min(1, 'Repository name is required'),
  pr: z.number().int().positive('PR number must be positive'),
  method: z.enum(['merge', 'squash', 'rebase']).default('squash'),
  commit_title: z.string().optional(),
  commit_message: z.string().optional(),
  delete_branch: z.boolean().default(true),
  confirm: z.literal(true, {
    errorMap: () => ({ message: 'Confirmation required: set confirm=true to merge (destructive operation)' })
  })
});

export type MergeInput = z.infer<typeof MergeInputSchema>;

// ============================================================================
// Types
// ============================================================================

export interface MergeOutput {
  success: boolean;
  merged: boolean;
  sha: string;
  message: string;
  method: 'merge' | 'squash' | 'rebase';
  branch_deleted: boolean;
  pr_number: number;
  url: string;
}

// ============================================================================
// Main Function
// ============================================================================

export async function prMerge(input: MergeInput): Promise<MergeOutput> {
  const validated = MergeInputSchema.parse(input);
  const { owner, repo, pr, method, commit_title, commit_message, delete_branch } = validated;

  const octokit = getOctokit();

  // First, get PR info to check state and get branch name
  let headRef: string;
  let prUrl: string;

  try {
    const { data: prData } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: pr
    });

    if (prData.state !== 'open') {
      throw new StructuredError(
        'parse',
        `PR #${pr} is ${prData.state}, not open`,
        false,
        prData.merged ? 'This PR has already been merged' : 'This PR has been closed'
      );
    }

    if (prData.draft) {
      throw new StructuredError(
        'parse',
        `PR #${pr} is a draft`,
        false,
        'Mark the PR as ready for review before merging'
      );
    }

    headRef = prData.head.ref;
    prUrl = prData.html_url;
  } catch (e) {
    if (e instanceof StructuredError) throw e;

    if (e && typeof e === 'object' && 'status' in e) {
      const status = (e as { status: number }).status;
      if (status === 404) {
        throw new StructuredError('not_found', `PR #${pr} not found`, false);
      }
    }

    throw new StructuredError(
      'network',
      `Failed to get PR info: ${e instanceof Error ? e.message : String(e)}`,
      true
    );
  }

  // Attempt merge
  let sha: string;
  try {
    const { data: mergeResult } = await octokit.pulls.merge({
      owner,
      repo,
      pull_number: pr,
      merge_method: method,
      commit_title,
      commit_message
    });

    if (!mergeResult.merged) {
      throw new StructuredError(
        'parse',
        `Merge failed: ${mergeResult.message}`,
        false
      );
    }

    sha = mergeResult.sha;
  } catch (e) {
    if (e instanceof StructuredError) throw e;

    if (e && typeof e === 'object' && 'status' in e) {
      const status = (e as { status: number }).status;
      const message = (e as { message?: string }).message || 'Unknown error';

      if (status === 403) {
        throw new StructuredError(
          'permission',
          `No permission to merge: ${message}`,
          false,
          'Check branch protection rules and required reviews'
        );
      }
      if (status === 405) {
        // Method Not Allowed - usually means merge is blocked
        throw new StructuredError(
          'parse',
          `Merge blocked: ${message}`,
          false,
          'Check: required reviews, status checks, merge conflicts'
        );
      }
      if (status === 409) {
        // Conflict
        throw new StructuredError(
          'parse',
          `Merge conflict: ${message}`,
          false,
          'Resolve conflicts before merging'
        );
      }

      throw new StructuredError('network', `GitHub API error: ${message}`, true);
    }

    throw new StructuredError(
      'network',
      `Failed to merge: ${e instanceof Error ? e.message : String(e)}`,
      true
    );
  }

  // Delete branch if requested
  let branchDeleted = false;
  if (delete_branch) {
    try {
      await octokit.git.deleteRef({
        owner,
        repo,
        ref: `heads/${headRef}`
      });
      branchDeleted = true;
    } catch {
      // Branch deletion is optional - don't fail if it doesn't work
      // (e.g., protected branch, already deleted, or from a fork)
      branchDeleted = false;
    }
  }

  return {
    success: true,
    merged: true,
    sha: sha.slice(0, 7),
    message: `PR #${pr} merged via ${method}`,
    method,
    branch_deleted: branchDeleted,
    pr_number: pr,
    url: prUrl
  };
}
