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
          'gh CLI unavailable - circuit breaker open',
          true,
          'Wait 60 seconds or check gh CLI status'
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
          'Run: gh auth login'
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

// ============================================================================
// Rate Limit Manager
// ============================================================================

class RateLimitManager {
  /**
   * Execute with exponential backoff on rate limit errors.
   * Uses reactive approach: retry on 429 errors with jitter.
   * Note: gh CLI doesn't expose rate limit headers, so proactive
   * rate limit tracking is not implemented.
   */
  async executeWithBackoff<T>(fn: () => Promise<T>, attempt = 0): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Error &&
          (e.message.includes('429') || e.message.includes('rate limit'))) {
        // Rate limit - backoff with jitter, max 3 retries
        if (attempt >= 3) {
          throw new StructuredError(
            'rate_limit',
            'Rate limit exceeded after 3 retries',
            true,
            'Wait a few minutes and try again'
          );
        }
        const jitter = Math.random() * 10000;
        await this.sleep(60000 + jitter);
        return this.executeWithBackoff(fn, attempt + 1);
      }
      throw e;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================================
// GitHub Client
// ============================================================================

export class GitHubClient {
  private circuitBreaker = new CircuitBreaker();
  private rateLimiter = new RateLimitManager();

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
   */
  async graphql<T>(query: string, variables: GraphQLVariables = {}): Promise<T> {
    return this.circuitBreaker.execute(() =>
      this.rateLimiter.executeWithBackoff(() =>
        this.executeGraphQL<T>(query, variables)
      )
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

          // Check for partial data
          if (e.data) {
            console.warn(`GraphQL warning: ${error.message}`);
            return e.data as T;
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
