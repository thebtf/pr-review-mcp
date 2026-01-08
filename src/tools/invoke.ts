/**
 * pr_invoke tool - Invoke AI code review agents on a PR
 */

import { z } from 'zod';
import { spawnSync } from 'child_process';
import { GitHubClient } from '../github/client.js';
import {
  InvokableAgentId,
  getInvokableAgentIds,
  isInvokableAgent
} from '../agents/registry.js';
import {
  invokeAgent,
  invokeMultipleAgents,
  aggregateResults,
  InvokeOptions,
  InvokeResult
} from '../agents/invoker.js';

// ============================================================================
// Input/Output Schemas
// ============================================================================

export const InvokeInputSchema = z.object({
  owner: z.string().min(1, 'Repository owner is required'),
  repo: z.string().min(1, 'Repository name is required'),
  pr: z.number().int().positive('PR number must be positive'),
  agent: z.enum(['coderabbit', 'sourcery', 'qodo', 'all'])
    .describe('Agent to invoke (or "all" for configured agents)'),
  options: z.object({
    focus: z.string().optional().describe('Review focus: security, performance, best-practices'),
    files: z.array(z.string()).optional().describe('Specific files to review'),
    incremental: z.boolean().optional().describe('Review only new changes')
  }).optional()
});

export type InvokeInput = z.infer<typeof InvokeInputSchema>;

export interface InvokeOutput {
  success: boolean;
  invoked: string[];
  failed: string[];
  results: InvokeResult[];
  message: string;
}

// ============================================================================
// Configuration Loading
// ============================================================================

interface RepoConfig {
  version?: number;
  invoke?: {
    agents?: string[];
    defaults?: InvokeOptions;
  };
}

/**
 * Get file content from repository via gh CLI
 */
async function getFileContent(
  owner: string,
  repo: string,
  path: string
): Promise<string | null> {
  const args = [
    'api',
    `repos/${owner}/${repo}/contents/${path}`,
    '--jq', '.content'
  ];

  const result = spawnSync('gh', args, {
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
    windowsHide: true
  });

  if (result.status !== 0 || !result.stdout) {
    return null;
  }

  // Content is base64 encoded
  const base64 = result.stdout.trim();
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/**
 * Get configured agents from repository config file
 * Falls back to all invokable agents if no config exists
 */
async function getConfiguredAgents(
  owner: string,
  repo: string
): Promise<{ agents: InvokableAgentId[]; defaults?: InvokeOptions }> {
  try {
    const content = await getFileContent(owner, repo, '.github/pr-review.json');

    if (!content) {
      return { agents: getInvokableAgentIds() };
    }

    const config: RepoConfig = JSON.parse(content);
    const configuredAgents = config.invoke?.agents || [];

    // Filter to only valid invokable agents
    const validAgents = configuredAgents.filter(
      (id): id is InvokableAgentId => isInvokableAgent(id)
    );

    return {
      agents: validAgents.length > 0 ? validAgents : getInvokableAgentIds(),
      defaults: config.invoke?.defaults
    };
  } catch {
    // Config file doesn't exist or is invalid - use all agents
    return { agents: getInvokableAgentIds() };
  }
}

// ============================================================================
// Main Tool Function
// ============================================================================

/**
 * Invoke AI code review agents on a PR
 *
 * @param input - Tool input (owner, repo, pr, agent, options)
 * @param client - GitHub client (for consistency with other tools, not used directly)
 * @returns Invocation results
 */
export async function prInvoke(
  input: InvokeInput,
  client: GitHubClient
): Promise<InvokeOutput> {
  const validated = InvokeInputSchema.parse(input);
  const { owner, repo, pr, agent, options } = validated;

  let agentsToInvoke: InvokableAgentId[];
  let mergedOptions = options;

  if (agent === 'all') {
    // Get agents from repo config
    const config = await getConfiguredAgents(owner, repo);
    agentsToInvoke = config.agents;

    // Merge options with defaults from config
    if (config.defaults) {
      mergedOptions = { ...config.defaults, ...options };
    }
  } else {
    agentsToInvoke = [agent];
  }

  // Invoke agents
  const results = await invokeMultipleAgents(
    owner,
    repo,
    pr,
    agentsToInvoke,
    mergedOptions
  );

  return aggregateResults(results);
}
