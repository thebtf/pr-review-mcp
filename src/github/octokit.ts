/**
 * Octokit Client Factory
 * Provides centralized access to GitHub API via @octokit libraries
 * with retry and throttling plugins configured.
 */

import { Octokit } from '@octokit/rest';
import { graphql } from '@octokit/graphql';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import type { GraphQlQueryResponseData } from '@octokit/graphql';
import { logger } from '../logging.js';

// ============================================================================
// Octokit with Plugins
// ============================================================================

// Use type annotation to avoid portable type inference issues
type OctokitWithPluginsType = Octokit & ReturnType<typeof retry> & ReturnType<typeof throttling>;
type OctokitWithPluginsConstructor = new (...args: ConstructorParameters<typeof Octokit>) => OctokitWithPluginsType;
const OctokitWithPlugins: OctokitWithPluginsConstructor =
  Octokit.plugin(retry, throttling) as unknown as OctokitWithPluginsConstructor;

// ============================================================================
// Singleton Instances
// ============================================================================

let octokitInstance: Octokit | null = null;
let graphqlInstance: typeof graphql | null = null;

// ============================================================================
// Token Validation
// ============================================================================

function getToken(): string {
  const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      'GITHUB_PERSONAL_ACCESS_TOKEN environment variable is required. ' +
      'Set it with a GitHub Personal Access Token that has repo scope.'
    );
  }
  return token;
}

// ============================================================================
// REST Client Factory
// ============================================================================

/**
 * Get the singleton Octokit REST client instance.
 * Configured with retry and throttling plugins.
 */
export function getOctokit(): Octokit {
  if (!octokitInstance) {
    const token = getToken();

    octokitInstance = new OctokitWithPlugins({
      auth: token,
      throttle: {
        onRateLimit: (retryAfter: number, options: { method: string; url: string }, _octokit, retryCount: number) => {
          logger.warning(
            `[octokit] Rate limit hit for ${options.method} ${options.url}, ` +
            `retrying after ${retryAfter}s (attempt ${retryCount + 1})`
          );
          // Retry up to 3 times
          return retryCount < 3;
        },
        onSecondaryRateLimit: (retryAfter: number, options: { method: string; url: string }, _octokit, retryCount: number) => {
          logger.warning(
            `[octokit] Secondary rate limit hit for ${options.method} ${options.url}, ` +
            `retrying after ${retryAfter}s (attempt ${retryCount + 1})`
          );
          // Retry up to 2 times for secondary limits
          return retryCount < 2;
        }
      },
      retry: {
        doNotRetry: ['429'], // Let throttling plugin handle rate limits
        retries: 3
      }
    });
  }

  return octokitInstance;
}

// ============================================================================
// GraphQL Client Factory
// ============================================================================

/**
 * Get the singleton GraphQL client instance.
 * Returns a function that can be called with query and variables.
 */
export function getGraphQL(): typeof graphql {
  if (!graphqlInstance) {
    const token = getToken();

    graphqlInstance = graphql.defaults({
      headers: {
        authorization: `token ${token}`
      }
    });
  }

  return graphqlInstance;
}

// ============================================================================
// Utility Types
// ============================================================================

export type { GraphQlQueryResponseData };

// Re-export Octokit types for convenience
export type OctokitClient = Octokit;

// ============================================================================
// Reset (for testing)
// ============================================================================

/**
 * Reset singleton instances (for testing purposes)
 */
export function resetClients(): void {
  octokitInstance = null;
  graphqlInstance = null;
}
