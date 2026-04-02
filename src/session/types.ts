/**
 * Session types for mcp-mux session-aware mode.
 *
 * Terminology (per clarification C3):
 * - "mux session" = mcp-mux session identified by _meta.muxSessionId
 * - "transport session" = HTTP transport session (mcp-session-id header)
 */

import type { Octokit } from '@octokit/rest';
import type { graphql } from '@octokit/graphql';
import type { GitHubClient } from '../github/client.js';
import type { CoordinationStateManager } from '../coordination/state.js';

/**
 * Extracted metadata from _meta injected by mcp-mux for session-aware servers.
 * When mcp-mux is not present (stdio mode), both fields use defaults.
 */
export interface MuxMeta {
  /** Session identifier from mcp-mux, or "default" for stdio/direct connections */
  readonly sessionId: string;
  /** Per-session environment variables diff from mcp-mux */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Per-session context holding all session-scoped state.
 * Created lazily on first request for each unique muxSessionId.
 */
export interface MuxSessionContext {
  readonly sessionId: string;
  readonly octokit: Octokit;
  readonly graphql: typeof graphql;
  readonly githubClient: GitHubClient;
  readonly coordination: CoordinationStateManager;
  /** The GitHub token this context was created with */
  readonly token: string;
  /** Timestamp of last access (for TTL cleanup) */
  lastActivity: number;
}

/** Configuration for MuxSessionManager */
export interface MuxSessionManagerOptions {
  /** Inactivity timeout before session cleanup (ms). Default: 30 minutes. */
  readonly cleanupTtlMs?: number;
  /** Interval between cleanup sweeps (ms). Default: 60 seconds. */
  readonly cleanupIntervalMs?: number;
}

/** Default session ID when mcp-mux is not present */
export const DEFAULT_SESSION_ID = 'default';
