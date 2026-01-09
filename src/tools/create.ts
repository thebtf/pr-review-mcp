/**
 * pr_create tool - Create a new pull request
 *
 * Creates a PR from an existing branch to a base branch.
 * Note: Does NOT create branches or push commits - use git for that.
 */

import { z } from 'zod';
import { getOctokit } from '../github/octokit.js';
import { StructuredError } from '../github/client.js';

// ============================================================================
// Schema
// ============================================================================

export const CreateInputSchema = z.object({
  owner: z.string().min(1, 'Repository owner is required'),
  repo: z.string().min(1, 'Repository name is required'),
  title: z.string().min(1, 'PR title is required'),
  body: z.string().optional(),
  base: z.string().default('main'),
  head: z.string().min(1, 'Head branch is required'),
  draft: z.boolean().default(false)
});

export type CreateInput = z.infer<typeof CreateInputSchema>;

// ============================================================================
// Types
// ============================================================================

export interface CreateOutput {
  success: boolean;
  pr_number: number;
  url: string;
  state: 'open' | 'draft';
  title: string;
  head: string;
  base: string;
}

// ============================================================================
// Main Function
// ============================================================================

export async function prCreate(input: CreateInput): Promise<CreateOutput> {
  const validated = CreateInputSchema.parse(input);
  const { owner, repo, title, body, base, head, draft } = validated;

  const octokit = getOctokit();

  try {
    const { data } = await octokit.pulls.create({
      owner,
      repo,
      title,
      body: body || '',
      base,
      head,
      draft
    });

    return {
      success: true,
      pr_number: data.number,
      url: data.html_url,
      state: data.draft ? 'draft' : 'open',
      title: data.title,
      head: data.head.ref,
      base: data.base.ref
    };
  } catch (e) {
    if (e && typeof e === 'object' && 'status' in e) {
      const status = (e as { status: number }).status;
      const message = (e as { message?: string }).message || 'Unknown error';

      if (status === 404) {
        throw new StructuredError(
          'not_found',
          `Repository or branch not found: ${message}`,
          false,
          'Ensure the repository exists and the head branch has been pushed'
        );
      }
      if (status === 403) {
        throw new StructuredError('permission', `No permission to create PR: ${message}`, false);
      }
      if (status === 422) {
        // Common errors: branch doesn't exist, PR already exists, no commits between branches
        if (message.includes('already exists')) {
          throw new StructuredError(
            'parse',
            `A pull request already exists for ${head}`,
            false,
            'Close the existing PR or use a different branch'
          );
        }
        if (message.includes('No commits')) {
          throw new StructuredError(
            'parse',
            `No commits between ${base} and ${head}`,
            false,
            'Ensure the head branch has commits not in the base branch'
          );
        }
        throw new StructuredError('parse', `Cannot create PR: ${message}`, false);
      }

      throw new StructuredError('network', `GitHub API error: ${message}`, true);
    }

    throw new StructuredError(
      'network',
      `Failed to create PR: ${e instanceof Error ? e.message : String(e)}`,
      true
    );
  }
}
