/**
 * GitHub Client - gh CLI wrapper with circuit breaker and rate limiting
 * Ported from coderabbit-processor.js lib/github-client.js
 */

import { spawnSync, execSync } from 'child_process';
import { randomUUID } from 'crypto';
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
  private remaining = 5000;
  private resetAt: Date | null = null;
  private readonly minRemaining = 100;

  async executeWithBackoff<T>(fn: () => Promise<T>, attempt = 0): Promise<T> {
    // Check if we should wait
    if (this.remaining < this.minRemaining && this.resetAt) {
      const waitMs = this.resetAt.getTime() - Date.now();
      if (waitMs > 0) {
        await this.sleep(Math.min(waitMs, 60000));
      }
    }

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

  update(remaining: number, resetAt: Date): void {
    this.remaining = remaining;
    this.resetAt = resetAt;
  }
}

// ============================================================================
// GitHub Client
// ============================================================================

export class GitHubClient {
  private circuitBreaker = new CircuitBreaker();
  private rateLimiter = new RateLimitManager();

  /**
   * Check prerequisites (gh CLI installed and authenticated)
   */
  checkPrerequisites(): void {
    // Check gh CLI installed
    try {
      execSync('gh --version', { stdio: 'pipe', encoding: 'utf-8' });
    } catch {
      throw new StructuredError(
        'not_found',
        'gh CLI not found',
        false,
        'Install from: https://cli.github.com'
      );
    }

    // Check auth
    try {
      execSync('gh auth status', { stdio: 'pipe', encoding: 'utf-8' });
    } catch {
      throw new StructuredError(
        'auth',
        'Not authenticated with GitHub',
        false,
        'Run: gh auth login'
      );
    }
  }

  /**
   * Execute GraphQL query via gh CLI
   */
  async graphql<T>(query: string, variables: GraphQLVariables = {}): Promise<T> {
    return this.circuitBreaker.execute(() =>
      this.rateLimiter.executeWithBackoff(() =>
        this.executeGraphQL<T>(query, variables)
      )
    );
  }

  /**
   * Internal GraphQL execution
   */
  private async executeGraphQL<T>(query: string, variables: GraphQLVariables): Promise<T> {
    // Build command args
    const args: string[] = ['api', 'graphql'];

    // Add query
    args.push('-f', `query=${query}`);

    // Add variables
    for (const [key, value] of Object.entries(variables)) {
      if (value !== undefined && value !== null) {
        // -F for non-string values (numbers, booleans), -f for strings
        const type = typeof value !== 'string' ? '-F' : '-f';
        args.push(type, `${key}=${value}`);
      }
    }

    try {
      const result = spawnSync('gh', args, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024, // 10MB
        windowsHide: true
      });

      if (result.error) {
        throw new StructuredError(
          'network',
          `gh CLI error: ${result.error.message}`,
          true
        );
      }

      if (result.status !== 0) {
        const stderr = result.stderr || '';

        // Parse specific error types
        if (stderr.includes('401') || stderr.includes('Bad credentials')) {
          throw new StructuredError('auth', 'Authentication failed', false, 'Run: gh auth login');
        }
        if (stderr.includes('403') && stderr.includes('rate')) {
          throw new StructuredError('rate_limit', 'Rate limit exceeded', true, 'Wait and retry');
        }
        if (stderr.includes('404')) {
          throw new StructuredError('not_found', 'Resource not found', false);
        }

        throw new StructuredError(
          'network',
          `gh CLI failed: ${stderr.slice(0, 500)}`,
          true
        );
      }

      const data = JSON.parse(result.stdout) as GraphQLResponse<T>;

      // Check for GraphQL errors
      if (data.errors && data.errors.length > 0) {
        const error = data.errors[0];

        if (error.type === 'NOT_FOUND') {
          throw new StructuredError('not_found', error.message, false);
        }
        if (error.type === 'FORBIDDEN') {
          throw new StructuredError('permission', error.message, false);
        }

        // Return partial data if available
        if (data.data) {
          console.warn(`GraphQL warning: ${error.message}`);
          return data.data;
        }

        throw new StructuredError('parse', `GraphQL error: ${error.message}`, false);
      }

      if (!data.data) {
        throw new StructuredError('parse', 'No data in GraphQL response', false);
      }

      return data.data;
    } catch (e) {
      if (e instanceof StructuredError) throw e;

      throw new StructuredError(
        'parse',
        `Failed to parse gh response: ${e instanceof Error ? e.message : String(e)}`,
        false
      );
    }
  }
}
