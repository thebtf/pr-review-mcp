/**
 * MuxSessionManager — manages per-session contexts for mcp-mux session-aware mode.
 *
 * Lifecycle:
 * 1. Tool handler calls getContext(extra) on every request
 * 2. Manager extracts MuxMeta from extra._meta
 * 3. Returns cached MuxSessionContext or creates a new one
 * 4. Periodic cleanup sweeps remove sessions inactive for cleanupTtlMs
 */

import { logger } from '../logging.js';
import { extractMuxMeta } from './meta.js';
import { createSessionContext } from './context.js';
import { DEFAULT_SESSION_ID } from './types.js';
import type { MuxMeta, MuxSessionContext, MuxSessionManagerOptions } from './types.js';

const DEFAULT_CLEANUP_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000;  // 1 minute

export class MuxSessionManager {
  private readonly sessions = new Map<string, MuxSessionContext>();
  private readonly cleanupTtlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: MuxSessionManagerOptions = {}) {
    this.cleanupTtlMs = options.cleanupTtlMs ?? DEFAULT_CLEANUP_TTL_MS;
    const intervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;

    this.cleanupTimer = setInterval(() => this.cleanupStaleSessions(), intervalMs);
    this.cleanupTimer.unref(); // Don't prevent process exit
  }

  /**
   * Get or create a MuxSessionContext from MCP SDK request handler extra.
   * Resolves token from: muxEnv.GITHUB_PERSONAL_ACCESS_TOKEN → process.env fallback.
   */
  getContext(extra: { _meta?: Record<string, unknown> } | undefined): MuxSessionContext {
    const meta = extractMuxMeta(extra);
    return this.getContextFromMeta(meta);
  }

  /**
   * Get or create a MuxSessionContext from pre-extracted MuxMeta.
   */
  getContextFromMeta(meta: MuxMeta): MuxSessionContext {
    const token = this.resolveToken(meta);

    const existing = this.sessions.get(meta.sessionId);
    if (existing) {
      // Token changed (e.g., mcp-mux restarted with new env) — recreate context
      if (existing.token !== token) {
        logger.warning(
          `[session] Token changed for session ${meta.sessionId}, recreating context`
        );
        const newCtx = createSessionContext(meta.sessionId, token);
        this.sessions.set(meta.sessionId, newCtx);
        return newCtx;
      }

      existing.lastActivity = Date.now();
      return existing;
    }

    // Create new session context
    const ctx = createSessionContext(meta.sessionId, token);
    this.sessions.set(meta.sessionId, ctx);
    logger.info(`[session] Created context for session ${meta.sessionId}`);
    return ctx;
  }

  /** Number of active sessions */
  get size(): number {
    return this.sessions.size;
  }

  /** Stop the cleanup timer (for graceful shutdown) */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
  }

  /**
   * Resolve GitHub token for a session.
   * Priority: muxEnv.GITHUB_PERSONAL_ACCESS_TOKEN > process.env.GITHUB_PERSONAL_ACCESS_TOKEN
   */
  private resolveToken(meta: MuxMeta): string {
    const envToken = meta.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    if (envToken && envToken.length > 0) {
      return envToken;
    }

    const processToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    if (processToken && processToken.length > 0) {
      return processToken;
    }

    throw new Error(
      'No GitHub token available. ' +
      'Set GITHUB_PERSONAL_ACCESS_TOKEN in .mcp.json env or as an environment variable.'
    );
  }

  /** Remove sessions that haven't been accessed within cleanupTtlMs */
  private cleanupStaleSessions(): void {
    const now = Date.now();
    const staleIds: string[] = [];

    for (const [id, ctx] of this.sessions) {
      // Never clean up the default session (stdio mode)
      if (id === DEFAULT_SESSION_ID) continue;

      if (now - ctx.lastActivity > this.cleanupTtlMs) {
        staleIds.push(id);
      }
    }

    for (const id of staleIds) {
      this.sessions.delete(id);
      logger.info(`[session] Cleaned up stale session ${id}`);
    }
  }
}
