/**
 * pr_invoke tool - Invoke AI code review agents on a PR
 */

import { z } from 'zod';
import { getOctokit } from '../github/octokit.js';
import { GitHubClient } from '../github/client.js';
import {
  InvokableAgentId,
  INVOKABLE_AGENTS,
  getDefaultAgents,
  isInvokableAgent
} from '../agents/registry.js';
import {
  invokeMultipleAgents,
  aggregateResults,
  InvokeOptions,
  InvokeResult
} from '../agents/invoker.js';
import { detectReviewedAgents } from '../agents/detector.js';
import { logger } from '../logging.js';

// ============================================================================
// Input/Output Schemas
// ============================================================================

export const InvokeInputSchema = z.object({
  owner: z.string().min(1, 'Repository owner is required'),
  repo: z.string().min(1, 'Repository name is required'),
  pr: z.number().int().positive('PR number must be positive'),
  agent: z.enum(['coderabbit', 'sourcery', 'qodo', 'gemini', 'codex', 'copilot', 'all'])
    .describe('Agent to invoke (or "all" for configured agents)'),
  options: z.object({
    focus: z.string().optional().describe('Review focus: security, performance, best-practices'),
    files: z.array(z.string()).optional().describe('Specific files to review'),
    incremental: z.boolean().optional().describe('Review only new changes'),
    force: z.boolean().optional().describe('Force re-invoke even if agent already reviewed')
  }).optional()
});

export type InvokeInput = z.infer<typeof InvokeInputSchema>;

export interface InvokeOutput {
  success: boolean;
  invoked: string[];
  failed: string[];
  /** Agents skipped because they already reviewed (unless force=true) */
  skipped: string[];
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
 * Get file content from repository via Octokit
 * Handles all GitHub Content API response types properly
 */
async function getFileContent(
  owner: string,
  repo: string,
  path: string
): Promise<string | null> {
  try {
    const octokit = getOctokit();
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path
    });

    // Can be a directory listing
    if (Array.isArray(data)) return null;

    // Only files have base64 content
    if (data.type !== 'file') return null;
    if (!('content' in data) || !data.content) return null;
    // Handle encoding: base64 for normal files, 'none' for 1-100MB files
    if ('encoding' in data && data.encoding !== 'base64') return null;

    return Buffer.from(data.content, 'base64').toString('utf-8');
  } catch {
    return null;
  }
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
      return { agents: getDefaultAgents() };
    }

    const config: RepoConfig = JSON.parse(content);
    const configuredAgents = config.invoke?.agents || [];

    // Filter to only valid invokable agents
    const validAgents = configuredAgents.filter(
      (id): id is InvokableAgentId => isInvokableAgent(id)
    );

    return {
      agents: validAgents.length > 0 ? validAgents : getDefaultAgents(),
      defaults: config.invoke?.defaults
    };
  } catch {
    // Config file doesn't exist or is invalid - use all agents
    return { agents: getDefaultAgents() };
  }
}

// ============================================================================
// Main Tool Function
// ============================================================================

/**
 * Invoke AI code review agents on a PR
 *
 * @param input - Tool input (owner, repo, pr, agent, options)
 * @returns Invocation results
 */
export async function prInvoke(
  input: InvokeInput
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

  // Smart detection: skip agents that already reviewed (unless force=true)
  const skipped: string[] = [];
  const force = mergedOptions?.force ?? false;

  if (!force) {
    const client = new GitHubClient();
    const detection = await detectReviewedAgents(client, owner, repo, pr);
    
    const originalCount = agentsToInvoke.length;
    agentsToInvoke = agentsToInvoke.filter(agentId => {
      if (detection.reviewed.has(agentId)) {
        const agentName = INVOKABLE_AGENTS[agentId].name;
        skipped.push(agentName);
        logger.info(`[invoke] Skipping ${agentName} - already reviewed`);
        return false;
      }
      return true;
    });

    if (skipped.length > 0) {
      logger.info(`[invoke] Skipped ${skipped.length}/${originalCount} agents (already reviewed)`);
    }
  }

  // If all agents were skipped, return early
  if (agentsToInvoke.length === 0) {
    return {
      success: true,
      invoked: [],
      failed: [],
      skipped,
      results: [],
      message: skipped.length > 0
        ? `All agents already reviewed: ${skipped.join(', ')}. Use force=true to re-invoke.`
        : 'No agents to invoke'
    };
  }

  // Invoke remaining agents
  const results = await invokeMultipleAgents(
    owner,
    repo,
    pr,
    agentsToInvoke,
    mergedOptions
  );

  return aggregateResults(results, skipped);
}
