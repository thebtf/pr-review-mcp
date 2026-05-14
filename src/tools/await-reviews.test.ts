/**
 * Unit tests for pr_await_reviews — T004 (always-bind), T005 (merged-PR short-circuit).
 */

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import { InvocationStore } from '../persistence/invocation-store.js';
import { prAwaitReviews } from './await-reviews.js';
import type { Octokit } from '@octokit/rest';

// ============================================================================
// In-memory store factory (same schema as in other test files)
// ============================================================================

function makeStore(): InvocationStore {
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE invocations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      owner         TEXT NOT NULL,
      repo          TEXT NOT NULL,
      pr            INTEGER NOT NULL,
      session_id    TEXT NOT NULL,
      agents        TEXT NOT NULL,
      since         TEXT NOT NULL,
      invoked_at    TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active',
      completed_at  TEXT,
      result        TEXT,
      UNIQUE(owner, repo, pr, since)
    );
    CREATE TABLE agent_status (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      invocation_id  INTEGER NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
      agent_id       TEXT NOT NULL,
      ready          INTEGER NOT NULL DEFAULT 0,
      confidence     TEXT,
      source         TEXT,
      last_activity  TEXT,
      timed_out      INTEGER NOT NULL DEFAULT 0,
      detail         TEXT,
      checked_at     TEXT NOT NULL,
      UNIQUE(invocation_id, agent_id)
    );
  `);

  return new InvocationStore(db);
}

// ============================================================================
// Mock Octokit factory
// ============================================================================

/**
 * Minimal Octokit mock. fetchCompletionStatus uses:
 *   - ok.paginate.iterator(...) for reviews and issue_comments
 *   - ok.paginate(...) for check_runs
 *   - ok.pulls.get for headSha + merged state
 * We stub all of these to return empty arrays / expected PR data.
 */
function makeMockOctokit(prOverrides: Partial<{
  merged: boolean;
  state: string;
  head_sha: string;
}> = {}): Octokit {
  // Each call to iterator() must return a fresh async generator.
  const paginateFn = vi.fn().mockResolvedValue([]) as unknown as Octokit['paginate'];
  (paginateFn as unknown as { iterator: ReturnType<typeof vi.fn> }).iterator = vi.fn().mockImplementation(
    async function* () { /* no pages */ },
  );

  return {
    pulls: {
      get: vi.fn().mockResolvedValue({
        data: {
          merged: prOverrides.merged ?? false,
          state: prOverrides.state ?? 'open',
          head: { sha: prOverrides.head_sha ?? 'abc123' },
        },
      }),
      listReviews: vi.fn(),
    },
    issues: {
      listComments: vi.fn(),
    },
    checks: {
      listForRef: vi.fn().mockResolvedValue({ data: { check_runs: [] } }),
    },
    paginate: paginateFn,
    request: vi.fn().mockRejectedValue(new Error('not mocked')),
  } as unknown as Octokit;
}

// ============================================================================
// T005 — Merged-PR short-circuit
// ============================================================================

describe('prAwaitReviews — merged-PR short-circuit', () => {
  it('returns completed=true immediately when PR is merged', async () => {
    const store = makeStore();
    const since = new Date(Date.now() - 60_000).toISOString();
    const id = store.record({
      owner: 'acme', repo: 'api', pr: 1,
      sessionId: 's', agents: ['coderabbit'], since,
    });

    const octokit = makeMockOctokit({ merged: true, state: 'closed' });

    const result = await prAwaitReviews(
      { owner: 'acme', repo: 'api', pr: 1, agents: ['coderabbit'], since, force: false },
      octokit,
      store,
      id,
    );

    expect(result.completed).toBe(true);
    expect(result.partial).toBe(false);
    expect(result.retryAfterMs).toBeNull();
    expect(result.agents.every(a => a.ready)).toBe(true);
    expect(result.agents[0].detail).toMatch(/merged/i);
  });

  it('returns completed=true immediately when PR is closed (not merged)', async () => {
    const store = makeStore();
    const since = new Date(Date.now() - 60_000).toISOString();
    const id = store.record({
      owner: 'acme', repo: 'api', pr: 2,
      sessionId: 's', agents: ['coderabbit'], since,
    });

    const octokit = makeMockOctokit({ merged: false, state: 'closed' });

    const result = await prAwaitReviews(
      { owner: 'acme', repo: 'api', pr: 2, agents: ['coderabbit'], since, force: false },
      octokit,
      store,
      id,
    );

    expect(result.completed).toBe(true);
    expect(result.agents[0].detail).toMatch(/closed/i);
  });

  it('marks the stored invocation as completed when PR is merged', async () => {
    const store = makeStore();
    const since = new Date(Date.now() - 60_000).toISOString();
    const id = store.record({
      owner: 'acme', repo: 'api', pr: 3,
      sessionId: 's', agents: ['coderabbit'], since,
    });

    const octokit = makeMockOctokit({ merged: true, state: 'closed' });

    await prAwaitReviews(
      { owner: 'acme', repo: 'api', pr: 3, agents: ['coderabbit'], since, force: false },
      octokit,
      store,
      id,
    );

    const inv = store.findById(id);
    expect(inv!.status).toBe('completed');
  });
});

// ============================================================================
// T004 — Always-bind: invocationId resolved for explicit-since callers
// ============================================================================

describe('prAwaitReviews — always-bind invocationId', () => {
  it('does not error when since is supplied but no invocation exists in store', async () => {
    const store = makeStore();
    const since = new Date(Date.now() - 60_000).toISOString();

    // Open PR with no reviews — reuses the shared factory.
    const octokit = makeMockOctokit({ merged: false, state: 'open' });

    // Should not throw; agents list will be pending.
    const result = await prAwaitReviews(
      { owner: 'acme', repo: 'api', pr: 99, agents: ['coderabbit'], since, force: false },
      octokit,
      store,
    );

    // No error field — the call completed normally (no invocation to bind to is fine).
    expect(result.error).toBeUndefined();
    expect(result.completed).toBe(false);
  });
});
