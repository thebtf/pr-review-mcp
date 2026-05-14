/**
 * Unit tests for pr_await_reviews — T004 (always-bind), T005 (merged-PR short-circuit),
 * T011 (WaitState classification).
 */

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import { InvocationStore } from '../persistence/invocation-store.js';
import { prAwaitReviews } from './await-reviews.js';
import { classifyWaitState } from './wait-state.js';
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

// ============================================================================
// T011 — WaitState classification (unit tests on classifyWaitState helper)
// ============================================================================

describe('classifyWaitState — WaitState unit classification', () => {
  // coderabbit: expectedTimeMs=300_000, maxWaitMs=720_000
  // sourcery:   expectedTimeMs=120_000, maxWaitMs=300_000

  it('returns normal when elapsed < expectedTimeMs', () => {
    // 1 minute elapsed, coderabbit expects 5 minutes
    const result = classifyWaitState('coderabbit', 60_000, false, undefined, undefined);
    expect(result.waitState).toBe('normal');
    expect(result.expectedTimeExceeded).toBe(false);
    expect(result.noProgressSinceMs).toBeNull();
  });

  it('returns slow when elapsed > expectedTimeMs and lastActivity is recent (<2 min)', () => {
    // 6 minutes elapsed (past 5-min expected), but agent signalled 30 seconds ago
    const recentActivity = new Date(Date.now() - 30_000).toISOString();
    const result = classifyWaitState('coderabbit', 360_000, false, recentActivity, undefined);
    expect(result.waitState).toBe('slow');
    expect(result.expectedTimeExceeded).toBe(true);
    expect(result.noProgressSinceMs).toBeGreaterThanOrEqual(0);
    expect(result.noProgressSinceMs).toBeLessThanOrEqual(60_000);
  });

  it('returns stalled when elapsed > expectedTimeMs and no lastActivity', () => {
    // 6 minutes elapsed, no signal ever seen
    const result = classifyWaitState('coderabbit', 360_000, false, undefined, undefined);
    expect(result.waitState).toBe('stalled');
    expect(result.expectedTimeExceeded).toBe(true);
    expect(result.noProgressSinceMs).toBeNull();
  });

  it('returns stalled when elapsed > expectedTimeMs and lastActivity is old (>2 min)', () => {
    // 6 minutes elapsed, last signal was 5 minutes ago
    const oldActivity = new Date(Date.now() - 300_000).toISOString();
    const result = classifyWaitState('coderabbit', 360_000, false, oldActivity, undefined);
    expect(result.waitState).toBe('stalled');
    expect(result.expectedTimeExceeded).toBe(true);
  });

  it('returns timed_out when timedOut=true regardless of other fields', () => {
    const result = classifyWaitState('coderabbit', 720_000, true, undefined, undefined);
    expect(result.waitState).toBe('timed_out');
    expect(result.expectedTimeExceeded).toBe(true);
  });

  it('returns timed_out even when elapsed < expectedTimeMs if timedOut=true', () => {
    // Unusual but possible if caller explicitly marks as timed out
    const result = classifyWaitState('sourcery', 10_000, true, undefined, undefined);
    expect(result.waitState).toBe('timed_out');
  });

  it('returns provider_limit when detail matches an excludePattern', () => {
    // sourcery has excludePatterns: [/rate limit/i, /review limit/i]
    const result = classifyWaitState('sourcery', 10_000, false, undefined, 'You have hit the rate limit for reviews');
    expect(result.waitState).toBe('provider_limit');
    expect(result.providerClue).toMatch(/rate limit/i);
  });

  it('sets expectedTimeExceeded=true when elapsed >= expectedTimeMs', () => {
    // Exactly at threshold
    const result = classifyWaitState('sourcery', 120_000, false, undefined, undefined);
    expect(result.expectedTimeExceeded).toBe(true);
  });

  it('sets expectedTimeExceeded=false when elapsed < expectedTimeMs', () => {
    const result = classifyWaitState('sourcery', 119_999, false, undefined, undefined);
    expect(result.expectedTimeExceeded).toBe(false);
  });

  it('noProgressSinceMs reflects time since lastActivity', () => {
    const activityTime = new Date(Date.now() - 45_000).toISOString();
    const result = classifyWaitState('coderabbit', 60_000, false, activityTime, undefined);
    // Should be approximately 45 seconds (±2s tolerance for test execution time)
    expect(result.noProgressSinceMs).toBeGreaterThanOrEqual(43_000);
    expect(result.noProgressSinceMs).toBeLessThanOrEqual(50_000);
  });
});

// ============================================================================
// T011 — WaitState in prAwaitReviews integration
// ============================================================================

describe('prAwaitReviews — waitState attached to non-ready agents', () => {
  it('attaches waitState=normal to a pending agent when elapsed < expectedTimeMs', async () => {
    const store = makeStore();
    // 1 minute ago — coderabbit expects 5 minutes
    const since = new Date(Date.now() - 60_000).toISOString();
    store.record({
      owner: 'acme', repo: 'api', pr: 10,
      sessionId: 's', agents: ['coderabbit'], since,
    });

    const octokit = makeMockOctokit({ merged: false, state: 'open' });

    const result = await prAwaitReviews(
      { owner: 'acme', repo: 'api', pr: 10, agents: ['coderabbit'], since, force: false },
      octokit,
      store,
    );

    const agent = result.agents.find(a => a.agentId === 'coderabbit');
    expect(agent).toBeDefined();
    expect(agent!.ready).toBe(false);
    expect(agent!.waitState).toBe('normal');
    expect(agent!.expectedTimeExceeded).toBe(false);
    expect(agent!.noProgressSinceMs).toBeNull();
  });

  it('ready agents have no waitState field set', async () => {
    const store = makeStore();
    const octokit = makeMockOctokit({ merged: true, state: 'closed' });
    const since = new Date(Date.now() - 60_000).toISOString();

    const result = await prAwaitReviews(
      { owner: 'acme', repo: 'api', pr: 11, agents: ['coderabbit'], since, force: false },
      octokit,
      store,
    );

    const agent = result.agents.find(a => a.agentId === 'coderabbit');
    expect(agent!.ready).toBe(true);
    // Ready agents skip classification — waitState should be undefined
    expect(agent!.waitState).toBeUndefined();
  });
});
