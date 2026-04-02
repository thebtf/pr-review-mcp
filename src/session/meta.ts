/**
 * Extract mcp-mux session metadata from MCP SDK request handler extra.
 *
 * mcp-mux injects `_meta.muxSessionId` and `_meta.muxEnv` into every request
 * for servers that declare `x-mux: { sharing: "session-aware" }`.
 * When mcp-mux is not present, falls back to default values.
 */

import type { MuxMeta } from './types.js';
import { DEFAULT_SESSION_ID } from './types.js';

/** Shape of the _meta object as injected by mcp-mux */
interface MuxMetaRaw {
  muxSessionId?: unknown;
  muxEnv?: unknown;
  [key: string]: unknown;
}

/**
 * Type guard for _meta containing mux fields.
 * Validates muxSessionId is a string if present.
 */
function hasMuxFields(meta: unknown): meta is MuxMetaRaw {
  return typeof meta === 'object' && meta !== null;
}

/**
 * Extract MuxMeta from the MCP SDK extra._meta field.
 *
 * @param extra - RequestHandlerExtra from MCP SDK tool handler callback.
 *   In SDK v1: extra._meta. In SDK v2: ctx.mcpReq._meta.
 *   Pass the object that has `_meta` on it.
 */
export function extractMuxMeta(extra: { _meta?: Record<string, unknown> } | undefined): MuxMeta {
  const meta = extra?._meta;

  if (!hasMuxFields(meta)) {
    return { sessionId: DEFAULT_SESSION_ID, env: {} };
  }

  const sessionId = typeof meta.muxSessionId === 'string' && meta.muxSessionId.length > 0
    ? meta.muxSessionId
    : DEFAULT_SESSION_ID;

  let env: Record<string, string> = {};
  if (typeof meta.muxEnv === 'object' && meta.muxEnv !== null && !Array.isArray(meta.muxEnv)) {
    const raw = meta.muxEnv as Record<string, unknown>;
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string') {
        filtered[key] = value;
      }
    }
    env = filtered;
  }

  return { sessionId, env };
}
