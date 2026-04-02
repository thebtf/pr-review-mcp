/**
 * Factory for creating per-session contexts.
 * Each MuxSessionContext holds session-scoped Octokit clients, GitHubClient,
 * and CoordinationStateManager.
 */

import { createOctokitForToken, createGraphQLForToken } from '../github/octokit.js';
import { GitHubClient } from '../github/client.js';
import { CoordinationStateManager } from '../coordination/state.js';
import type { MuxSessionContext } from './types.js';

/**
 * Create a new MuxSessionContext for a given session ID and GitHub token.
 * Instantiates per-session Octokit, GraphQL, GitHubClient, and CoordinationStateManager.
 */
export function createSessionContext(sessionId: string, token: string): MuxSessionContext {
  const octokit = createOctokitForToken(token);
  const graphql = createGraphQLForToken(token);
  const githubClient = new GitHubClient(graphql);
  const coordination = new CoordinationStateManager();

  return {
    sessionId,
    octokit,
    graphql,
    githubClient,
    coordination,
    token,
    lastActivity: Date.now(),
  };
}
