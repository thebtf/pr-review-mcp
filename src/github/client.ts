/**
 * GitHub Client - Octokit-based with circuit breaker
 * Migrated from gh CLI wrapper to @octokit/graphql
 */

import { randomUUID } from 'crypto';
import { getGraphQL } from './octokit.js';
import { GraphqlResponseError } from '@octokit/graphql';
import type { GraphQLVariables, GraphQLResponse, GraphQLError } from './types.js';

// ============================================================================
// Structured Error
// ============================================================================

export type ErrorKind = 'auth' | 'rate_limit' | 'network' | 'parse' | 'permission' | 'not_found' | 'circuit_open';

export class StructuredError extends Error {
  readonly kind: ErrorKind;
  readonly retryable: boolean;
  readonly userAction: string | null;
  readonly correlationId: string;

  constructor(kind: ErrorKind, message: string, retryable: boolean, userAction: string | null = null) {
    super(message);
    this.name = 'StructuredError';
    this.kind = kind;
    this.retryable = retryable;
    this.userAction = userAction;
    this.correlationId = randomUUID();
  }

  toJSON() {
    return {
      success: false,
      error: {
        kind: this.kind,
        message: this.message,
        retryable: this.retryable,
        user_action: this.userAction,
        correlation_id: this.correlationId
      }
    };
  }
}

// ============================================================================
// Circuit Breaker
// ============================================================================

type CircuitState = 'closed' | 'open' | 'half-open';

class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private lastFailure: number | null = null;
  private readonly resetTimeoutMs = 60000; // 1 minute
  private readonly failureThreshold = 3;

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (this.lastFailure && Date.now() - this.lastFailure > this.resetTimeoutMs) {
        this.state = 'half-open';
      } else {
        throw new StructuredError(
          'circuit_open',
          'GitHub API unavailable - circuit breaker open',
          true,
          'Wait 60 seconds before retrying'
        );
      }
    }

    try {
      const result = await fn();
      this.failures = 0;
      this.state = 'closed';
      return result;
    } catch (e) {
      this.failures++;
      this.lastFailure = Date.now();

      // Auth errors = immediate open (won't self-heal)
      if (e instanceof Error &&
          (e.message.includes('401') ||
           e.message.includes('Bad credentials') ||
           e.message.includes('not logged'))) {
        this.state = 'open';
        throw new StructuredError(
          'auth',
          'Authentication failed',
          false,
          'Check GITHUB_PERSONAL_ACCESS_TOKEN environment variable'
        );
      }

      // Open circuit after threshold failures
      if (this.failures >= this.failureThreshold) {
        this.state = 'open';
      }

      throw e;
    }
  }

  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.lastFailure = null;
  }
}

// Rate limiting is handled by @octokit/plugin-throttling in octokit.ts

// ============================================================================
// GitHub Client
// ============================================================================

export class GitHubClient {
  private circuitBreaker = new CircuitBreaker();

  /**
   * Check prerequisites (GITHUB_PERSONAL_ACCESS_TOKEN set)
   */
  checkPrerequisites(): void {
    if (!process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
      throw new StructuredError(
        'auth',
        'GITHUB_PERSONAL_ACCESS_TOKEN not set',
        false,
        'Set GITHUB_PERSONAL_ACCESS_TOKEN environment variable'
      );
    }
  }

  /**
   * Execute GraphQL query via Octokit
   * Rate limiting handled by @octokit/plugin-throttling
   */
  async graphql<T>(query: string, variables: GraphQLVariables = {}): Promise<T> {
    return this.circuitBreaker.execute(() =>
      this.executeGraphQL<T>(query, variables)
    );
  }

  /**
   * Internal GraphQL execution via @octokit/graphql
   */
  private async executeGraphQL<T>(query: string, variables: GraphQLVariables): Promise<T> {
    try {
      const graphqlClient = getGraphQL();
      const response = await graphqlClient<T>(query, variables);
      return response;
    } catch (e) {
      if (e instanceof StructuredError) throw e;

      // Handle Octokit GraphQL errors
      if (e instanceof GraphqlResponseError) {
        const errors = e.errors || [];
        if (errors.length > 0) {
          const error = errors[0] as GraphQLError;

          if (error.type === 'NOT_FOUND') {
            throw new StructuredError('not_found', error.message, false);
          }
          if (error.type === 'FORBIDDEN') {
            throw new StructuredError('permission', error.message, false);
          }

          // Partial data is unreliable - throw error instead of returning incomplete results
          if (e.data) {
            throw new StructuredError(
              'parse',
              `GraphQL returned partial data: ${error.message}`,
              false,
              'Query returned incomplete results - check permissions or data availability'
            );
          }

          throw new StructuredError('parse', `GraphQL error: ${error.message}`, false);
        }
      }

      // Handle HTTP errors from underlying request
      if (e && typeof e === 'object' && 'status' in e) {
        const status = (e as { status: number }).status;
        const message = (e as { message?: string }).message || 'Unknown error';

        if (status === 401) {
          throw new StructuredError('auth', 'Authentication failed', false, 'Check GITHUB_PERSONAL_ACCESS_TOKEN');
        }
        if (status === 403) {
          if (message.toLowerCase().includes('rate')) {
            throw new StructuredError('rate_limit', 'Rate limit exceeded', true, 'Wait and retry');
          }
          throw new StructuredError('permission', message, false);
        }
        if (status === 404) {
          throw new StructuredError('not_found', 'Resource not found', false);
        }

        throw new StructuredError('network', `GitHub API error (${status}): ${message}`, true);
      }

      throw new StructuredError(
        'network',
        `GitHub API error: ${e instanceof Error ? e.message : String(e)}`,
        true
      );
    }
  }
}
