/**
 * Agent Invoker - Logic for invoking AI code review agents
 */

import { getOctokit } from '../github/octokit.js';
import { StructuredError } from '../github/client.js';
import { AgentConfig, getAgentConfig, getInvokableAgentIds, InvokableAgentId } from './registry.js';

export interface InvokeOptions {
  /** Review focus area: security, performance, best-practices */
  focus?: string;
  /** Specific files to review */
  files?: string[];
  /** Review only new changes since last review */
  incremental?: boolean;
}

export interface InvokeResult {
  success: boolean;
  agent: string;
  agentName: string;
  commentUrl: string | null;
  message: string;
}

/**
 * Build the command string with options appended
 */
export function buildCommand(config: AgentConfig, options?: InvokeOptions): string {
  let command = config.command;

  if (!options) return command;

  const parts: string[] = [];

  // Add focus option
  if (options.focus && config.supports.includes('focus')) {
    parts.push(`focus:${options.focus}`);
  }

  // Add files option
  if (options.files?.length && config.supports.includes('files')) {
    parts.push(`files:${options.files.join(',')}`);
  }

  // Add incremental option
  if (options.incremental && config.supports.includes('incremental')) {
    parts.push('incremental');
  }

  if (parts.length > 0) {
    command += ` ${parts.join(' ')}`;
  }

  return command;
}

/**
 * Post a comment to invoke an agent
 */
export async function postInvocationComment(
  owner: string,
  repo: string,
  pr: number,
  command: string,
  config: AgentConfig
): Promise<InvokeResult> {
  try {
    const octokit = getOctokit();
    const { data } = await octokit.issues.createComment({
      owner,
      repo,
      issue_number: pr,
      body: command
    });

    return {
      success: true,
      agent: config.name.toLowerCase(),
      agentName: config.name,
      commentUrl: data.html_url,
      message: `Successfully invoked ${config.name}. ` +
        `Note: This tool cannot verify that the ${config.name} GitHub App is installed. ` +
        `If no review appears, check the repository's GitHub Apps settings.`
    };
  } catch (e) {
    // Handle specific HTTP errors
    if (e && typeof e === 'object' && 'status' in e) {
      const status = (e as { status: number }).status;
      const message = (e as { message?: string }).message || 'Unknown error';

      if (status === 401) {
        throw new StructuredError('auth', 'Authentication failed', false, 'Check GITHUB_PERSONAL_ACCESS_TOKEN');
      }
      if (status === 404) {
        return {
          success: false,
          agent: config.name.toLowerCase(),
          agentName: config.name,
          commentUrl: null,
          message: `PR not found: ${owner}/${repo}#${pr}`
        };
      }

      return {
        success: false,
        agent: config.name.toLowerCase(),
        agentName: config.name,
        commentUrl: null,
        message: `GitHub API error (${status}): ${message.slice(0, 200)}`
      };
    }

    if (e instanceof StructuredError) throw e;

    return {
      success: false,
      agent: config.name.toLowerCase(),
      agentName: config.name,
      commentUrl: null,
      message: `Unexpected error: ${e instanceof Error ? e.message : String(e)}`
    };
  }
}

/**
 * Invoke a single agent
 */
export async function invokeAgent(
  owner: string,
  repo: string,
  pr: number,
  agentId: InvokableAgentId,
  options?: InvokeOptions
): Promise<InvokeResult> {
  const config = getAgentConfig(agentId);

  if (!config) {
    return {
      success: false,
      agent: agentId,
      agentName: agentId,
      commentUrl: null,
      message: `Unknown agent: ${agentId}. Valid agents: ${getInvokableAgentIds().join(', ')}`
    };
  }

  const command = buildCommand(config, options);
  return postInvocationComment(owner, repo, pr, command, config);
}

/**
 * Invoke multiple agents in parallel and aggregate results
 */
export async function invokeMultipleAgents(
  owner: string,
  repo: string,
  pr: number,
  agentIds: InvokableAgentId[],
  options?: InvokeOptions
): Promise<InvokeResult[]> {
  const promises = agentIds.map(agentId =>
    invokeAgent(owner, repo, pr, agentId, options)
  );

  return Promise.all(promises);
}

/**
 * Aggregate multiple invoke results into a summary
 */
export function aggregateResults(results: InvokeResult[]): {
  success: boolean;
  invoked: string[];
  failed: string[];
  results: InvokeResult[];
  message: string;
} {
  const invoked = results.filter(r => r.success).map(r => r.agentName);
  const failed = results.filter(r => !r.success).map(r => r.agentName);

  let message: string;
  if (failed.length === 0) {
    message = `Successfully invoked: ${invoked.join(', ')}`;
  } else if (invoked.length === 0) {
    message = `Failed to invoke: ${failed.join(', ')}`;
  } else {
    message = `Invoked: ${invoked.join(', ')}. Failed: ${failed.join(', ')}`;
  }

  return {
    success: failed.length === 0,
    invoked,
    failed,
    results,
    message
  };
}
