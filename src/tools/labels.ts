/**
 * pr_labels tool - Manage PR labels
 *
 * Get, add, remove, or set labels on a pull request.
 */

import { z } from 'zod';
import { getOctokit } from '../github/octokit.js';
import { StructuredError } from '../github/client.js';

// ============================================================================
// Schema
// ============================================================================

export const LabelsInputSchema = z.object({
  owner: z.string().min(1, 'Repository owner is required'),
  repo: z.string().min(1, 'Repository name is required'),
  pr: z.number().int().positive('PR number must be positive'),
  action: z.enum(['get', 'add', 'remove', 'set']),
  labels: z.array(z.string().min(1)).optional()
}).refine(
  (data) => data.action === 'get' || (data.labels && data.labels.length > 0),
  { message: 'At least one label is required for add/remove/set actions', path: ['labels'] }
);

export type LabelsInput = z.infer<typeof LabelsInputSchema>;

// ============================================================================
// Types
// ============================================================================

export interface LabelsOutput {
  success: boolean;
  action: 'get' | 'add' | 'remove' | 'set';
  labels: string[]; // Current labels after operation
  added?: string[];
  removed?: string[];
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Helper to extract label names from GitHub API response
 */
function extractLabelNames(labels: Array<string | { name?: string }>): string[] {
  return labels
    .map(l => (typeof l === 'string' ? l : l.name || ''))
    .filter(Boolean);
}

// ============================================================================
// Main Function
// ============================================================================

export async function prLabels(input: LabelsInput): Promise<LabelsOutput> {
  const validated = LabelsInputSchema.parse(input);
  const { owner, repo, pr, action, labels } = validated;

  const octokit = getOctokit();

  try {
    let currentLabels: string[] = [];

    switch (action) {
      case 'get': {
        const { data: issue } = await octokit.issues.get({
          owner,
          repo,
          issue_number: pr
        });
        currentLabels = extractLabelNames(issue.labels);
        return {
          success: true,
          action: 'get',
          labels: currentLabels
        };
      }

      case 'add': {
        const { data } = await octokit.issues.addLabels({
          owner,
          repo,
          issue_number: pr,
          labels: labels!
        });
        currentLabels = data.map(l => l.name);
        return {
          success: true,
          action: 'add',
          labels: currentLabels,
          added: labels
        };
      }

      case 'remove': {
        const removed: string[] = [];
        for (const label of labels!) {
          try {
            await octokit.issues.removeLabel({
              owner,
              repo,
              issue_number: pr,
              name: label
            });
            removed.push(label);
          } catch (e) {
            // Label might not exist - continue with others
            if (e && typeof e === 'object' && 'status' in e && (e as { status: number }).status === 404) {
              continue;
            }
            throw e;
          }
        }

        // Get current labels after removal
        const { data: issue } = await octokit.issues.get({
          owner,
          repo,
          issue_number: pr
        });
        currentLabels = extractLabelNames(issue.labels);

        return {
          success: true,
          action: 'remove',
          labels: currentLabels,
          removed
        };
      }

      case 'set': {
        const { data } = await octokit.issues.setLabels({
          owner,
          repo,
          issue_number: pr,
          labels: labels!
        });
        currentLabels = data.map(l => l.name);
        return {
          success: true,
          action: 'set',
          labels: currentLabels
        };
      }

      default: {
        const _exhaustiveCheck: never = action;
        throw new Error(`Unknown action: ${_exhaustiveCheck}`);
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
        throw new StructuredError('permission', `No permission to modify labels: ${message}`, false);
      }
      if (status === 422) {
        throw new StructuredError('parse', `Invalid label: ${message}`, false);
      }

      throw new StructuredError('network', `GitHub API error: ${message}`, true);
    }

    throw new StructuredError(
      'network',
      `Failed to ${action} labels: ${e instanceof Error ? e.message : String(e)}`,
      true
    );
  }
}
