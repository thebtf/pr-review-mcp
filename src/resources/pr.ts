/**
 * PR Resources - MCP Resources implementation for pull requests
 */

import { ErrorCode, McpError, Resource } from '@modelcontextprotocol/sdk/types.js';
import { GitHubClient, StructuredError } from '../github/client.js';
import { prSummary } from '../tools/summary.js';
import { prListPRs } from '../tools/list-prs.js';

/**
 * List all available PR resources
 * Returns empty array as resources are dynamically accessed via URI
 */
export async function listPRResources(): Promise<Resource[]> {
  return [];
}

/**
 * Read a PR resource by URI
 * URI format: pr://{owner}/{repo}/{pr}
 */
export async function readPRResource(uri: string, client: GitHubClient): Promise<any> {
  // Parse URI format: pr://{owner}/{repo}/{pr}
  const match = uri.match(/^pr:\/\/([^/]+)\/([^/]+)\/(\d+)$/);
  if (!match) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Invalid PR resource URI format. Expected: pr://{owner}/{repo}/{pr}`
    );
  }

  const [, owner, repo, prStr] = match;
  const pr = parseInt(prStr, 10);

  try {
    // Fetch PR summary using existing prSummary tool
    const summary = await prSummary({ owner, repo, pr }, client);

    // Get PR info for additional context
    const prListResult = await prListPRs({ owner, repo, state: 'all', limit: 100 }, client);
    const prInfo = prListResult.pullRequests.find(p => p.number === pr);

    // Build resource content
    const content = {
      pr: {
        owner,
        repo,
        number: pr,
        ...(prInfo ? {
          title: prInfo.title,
          state: prInfo.state,
          isDraft: prInfo.isDraft,
          author: prInfo.author,
          branch: prInfo.branch,
          baseBranch: prInfo.baseBranch,
          mergeable: prInfo.mergeable,
          reviewDecision: prInfo.reviewDecision,
          createdAt: prInfo.createdAt,
          updatedAt: prInfo.updatedAt
        } : {})
      },
      summary: {
        total: summary.total,
        resolved: summary.resolved,
        unresolved: summary.unresolved,
        outdated: summary.outdated,
        bySeverity: summary.bySeverity,
        byFile: summary.byFile,
        ...(summary.nitpicks ? { nitpicks: summary.nitpicks } : {})
      }
    };

    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(content, null, 2)
        }
      ]
    };
  } catch (error) {
    if (error instanceof StructuredError) {
      const errorCodeMap: Record<string, ErrorCode> = {
        'auth': ErrorCode.InvalidRequest,
        'permission': ErrorCode.InvalidRequest,
        'not_found': ErrorCode.InvalidRequest,
        'parse': ErrorCode.InvalidRequest,
        'rate_limit': ErrorCode.InternalError,
        'network': ErrorCode.InternalError,
        'circuit_open': ErrorCode.InternalError
      };
      throw new McpError(
        errorCodeMap[error.kind] ?? ErrorCode.InternalError,
        error.message
      );
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new McpError(ErrorCode.InternalError, `Failed to read resource: ${errorMessage}`);
  }
}
