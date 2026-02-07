/**
 * PR Review Setup / Onboarding Prompt
 *
 * Generates a prompt that guides the user through configuring
 * .github/pr-review.json for their repository.
 *
 * Usage:
 * - /pr:setup                → Setup for current repo (infer from git)
 * - /pr:setup owner/repo     → Setup for specific repo
 */

import { getOctokit } from '../github/octokit.js';
import {
  INVOKABLE_AGENTS,
  getEnvConfig
} from '../agents/registry.js';

// ============================================================================
// Types
// ============================================================================

export interface SetupPromptArgs {
  /** Repository in "owner/repo" format */
  repo?: string;
}

// ============================================================================
// Config Reader
// ============================================================================

interface RepoConfig {
  version?: number;
  invoke?: {
    agents?: string[];
    defaults?: {
      focus?: string;
      incremental?: boolean;
    };
  };
}

async function readRepoConfig(
  owner: string,
  repo: string
): Promise<{ exists: boolean; config?: RepoConfig; error?: string }> {
  try {
    const octokit = getOctokit();
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: '.github/pr-review.json'
    });

    if (Array.isArray(data) || data.type !== 'file' || !('content' in data) || !data.content) {
      return { exists: false };
    }

    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    try {
      const config: RepoConfig = JSON.parse(content);
      return { exists: true, config };
    } catch (parseError) {
      return { exists: true, error: 'Invalid JSON in config file' };
    }
  } catch (error) {
    // A 404 is expected if the file doesn't exist. Other errors (e.g., auth) are not.
    if (error && typeof error === 'object' && 'status' in error && (error as { status: number }).status === 404) {
      return { exists: false };
    }
    // Log unexpected errors for debugging but still return exists: false to avoid breaking the prompt
    console.error(`[readRepoConfig] Unexpected error fetching config for ${owner}/${repo}:`, error);
    return { exists: false, error: 'Failed to fetch config' };
  }
}

// ============================================================================
// Prompt Generator
// ============================================================================

export async function generateSetupPrompt(
  args: SetupPromptArgs
): Promise<string> {
  // Parse owner/repo
  let owner: string | undefined;
  let repo: string | undefined;

  if (args.repo) {
    const parts = args.repo.split('/');
    if (parts.length === 2) {
      owner = parts[0];
      repo = parts[1];
    }
  }

  // Build agent table
  const agentRows = Object.entries(INVOKABLE_AGENTS)
    .map(([id, cfg]) => `| \`${id}\` | ${cfg.name} | ${cfg.type} | ${cfg.supports.join(', ') || 'none'} |`)
    .join('\n');

  // Current env config
  const envConfig = getEnvConfig();
  const envAgents = envConfig.agents.join(', ');

  // Repo config (if we have owner/repo)
  let repoConfigSection = '';
  if (owner && repo) {
    const { exists, config, error } = await readRepoConfig(owner, repo);
    if (exists && config) {
      const repoAgents = config.invoke?.agents?.join(', ') || 'not specified';
      repoConfigSection = `
### Current Repo Config (\`.github/pr-review.json\`)
\`\`\`json
${JSON.stringify(config, null, 2)}
\`\`\`
- Agents: ${repoAgents}
`;
    } else if (exists && error) {
      repoConfigSection = `
### Repo Config: ERROR
\`.github/pr-review.json\` exists in \`${owner}/${repo}\` but could not be read: ${error}
`;
    } else if (error) {
      repoConfigSection = `
### Repo Config: ACCESS ERROR
Failed to check \`.github/pr-review.json\` in \`${owner}/${repo}\`: ${error}
`;
    } else {
      repoConfigSection = `
### Repo Config: NOT FOUND
\`.github/pr-review.json\` does not exist in \`${owner}/${repo}\`.
`;
    }
  }

  // Need to infer repo
  const inferSection = (!owner || !repo) ? `
## Step 1: Identify Repository

Run this command to get the repository:
\`\`\`bash
git remote get-url origin
\`\`\`
Parse the result to extract owner/repo.
` : '';

  const targetRepo = (owner && repo) ? `${owner}/${repo}` : '(infer from git remote)';

  return `# PR Review Setup

**Target:** ${targetRepo}
${inferSection}
## Configuration Priority

| Priority | Source | Scope |
|----------|--------|-------|
| 1 (highest) | \`.github/pr-review.json\` | Per-repository |
| 2 | \`PR_REVIEW_AGENTS\` env var | Per MCP server instance |
| 3 (lowest) | Built-in default | \`coderabbit\` only |

## Current State

### Environment Config
- **PR_REVIEW_AGENTS:** \`${envAgents}\`
- **PR_REVIEW_MODE:** \`${envConfig.mode}\`
${repoConfigSection}
## Available Agents

| ID | Name | Type | Supports |
|----|------|------|----------|
${agentRows}

## Setup Instructions

Create \`.github/pr-review.json\` in the repository to configure which agents are invoked when using \`pr_invoke { agent: "all" }\`.

### Example Config

\`\`\`json
{
  "version": 1,
  "invoke": {
    "agents": ["coderabbit", "gemini", "codex"],
    "defaults": {
      "focus": "best-practices"
    }
  }
}
\`\`\`

### Config Fields

| Field | Type | Description |
|-------|------|-------------|
| \`version\` | number | Config version (currently 1) |
| \`invoke.agents\` | string[] | Agent IDs to invoke with \`agent: "all"\` |
| \`invoke.defaults.focus\` | string | Default review focus |
| \`invoke.defaults.incremental\` | boolean | Default to incremental reviews |

## Action

Ask the user which agents they want for this repository, then create \`.github/pr-review.json\` using the GitHub API or by committing directly.

**Do NOT auto-merge or push without confirmation.**
`;
}

// ============================================================================
// Prompt Definition for MCP
// ============================================================================

export const SETUP_PROMPT_DEFINITION = {
  name: 'setup',
  title: 'PR Review Setup',
  description: 'Configure AI review agents for a repository. Creates .github/pr-review.json with agent selection and defaults.',
  arguments: [
    {
      name: 'repo',
      description: 'Repository in owner/repo format. Omit to infer from git remote.',
      required: false
    }
  ]
};
