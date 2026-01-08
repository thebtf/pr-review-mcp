/**
 * Agent Invoker - Logic for invoking AI code review agents
 */

import { spawnSync } from 'child_process';
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
  const args = [
    'pr', 'comment', String(pr),
    '--repo', `${owner}/${repo}`,
    '--body', command
  ];

  // Apply MSYS workaround for slash commands on Windows
  const env = config.msysWorkaround && process.platform === 'win32'
    ? { ...process.env, MSYS_NO_PATHCONV: '1' }
    : process.env;

  try {
    const result = spawnSync('gh', args, {
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env
    });

    if (result.error) {
      return {
        success: false,
        agent: config.name.toLowerCase(),
        agentName: config.name,
        commentUrl: null,
        message: `Failed to execute gh CLI: ${result.error.message}`
      };
    }

    if (result.status !== 0) {
      const stderr = result.stderr || '';

      // Parse common errors
      if (stderr.includes('401') || stderr.includes('Bad credentials')) {
        throw new StructuredError('auth', 'Authentication failed', false, 'Run: gh auth login');
      }
      if (stderr.includes('404')) {
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
        message: `gh CLI error: ${stderr.slice(0, 200)}`
      };
    }

    // Parse comment URL from stdout (gh pr comment outputs the URL)
    const stdout = result.stdout.trim();
    const urlMatch = stdout.match(/https:\/\/github\.com\/[^\s]+/);
    const commentUrl = urlMatch ? urlMatch[0] : null;

    return {
      success: true,
      agent: config.name.toLowerCase(),
      agentName: config.name,
      commentUrl,
      message: `Successfully invoked ${config.name}. ` +
        `Note: This tool cannot verify that the ${config.name} GitHub App is installed. ` +
        `If no review appears, check the repository's GitHub Apps settings.`
    };
  } catch (e) {
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
 * Invoke multiple agents and aggregate results
 */
export async function invokeMultipleAgents(
  owner: string,
  repo: string,
  pr: number,
  agentIds: InvokableAgentId[],
  options?: InvokeOptions
): Promise<InvokeResult[]> {
  const results: InvokeResult[] = [];

  for (const agentId of agentIds) {
    const result = await invokeAgent(owner, repo, pr, agentId, options);
    results.push(result);
  }

  return results;
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
