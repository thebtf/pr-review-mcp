/**
 * PR Resources - MCP Resources implementation for pull requests
 */

import { ErrorCode, McpError, Resource } from '@modelcontextprotocol/sdk/types.js';
import { GitHubClient, StructuredError } from '../github/client.js';
import { prSummary } from '../tools/summary.js';
import { QUERIES } from '../github/queries.js';

/**
 * Response type for getPullRequest query
 */
interface GetPullRequestResponse {
  repository: {
    pullRequest: {
      number: number;
      title: string;
      state: string;
      isDraft: boolean;
      createdAt: string;
      updatedAt: string;
      author: { login: string } | null;
      baseRefName: string;
      headRefName: string;
      mergeable: string;
      reviewDecision: string | null;
    } | null;
  } | null;
}

/**
 * MCP Resource response structure
 */
interface PRResourceResponse {
  contents: Array<{
    uri: string;
    mimeType: string;
    text: string;
  }>;
}

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
export async function readPRResource(uri: string, client: GitHubClient): Promise<PRResourceResponse & Record<string, unknown>> {
  // Parse URI format: pr://{owner}/{repo}/{pr}
  const match = uri.match(/^pr:\/\/([^/]+)\/([^/]+)\/(\d+)$/);
  if (!match) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid PR resource URI format. Expected: pr://{owner}/{repo}/{pr}`
    );
  }

  const [, owner, repo, prStr] = match;
  const pr = parseInt(prStr, 10);

  try {
    // Fetch PR summary and PR info in parallel for efficiency
    const [summary, prResponse] = await Promise.all([
      prSummary({ owner, repo, pr }, client),
      client.graphql<GetPullRequestResponse>(QUERIES.getPullRequest, { owner, repo, pr })
    ]);

    const prInfo = prResponse.repository?.pullRequest;

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
          author: prInfo.author?.login ?? null,
          branch: prInfo.headRefName,
          baseBranch: prInfo.baseRefName,
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
      // Use JSON-RPC 2.0 compliant error codes:
      // - -32602: Invalid params (parse errors)
      // - -32001: Authentication error (application-level)
      // - -32004: Not found (application-level)
      // - -32603: Internal error (rate limit, network, circuit)
      const errorCodeMap: Record<string, number> = {
        'auth': -32001,           // Application-level auth error
        'permission': -32001,     // Application-level permission error
        'not_found': -32004,      // Application-level not found
        'parse': ErrorCode.InvalidParams as number,
        'rate_limit': ErrorCode.InternalError as number,
        'network': ErrorCode.InternalError as number,
        'circuit_open': ErrorCode.InternalError as number
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
