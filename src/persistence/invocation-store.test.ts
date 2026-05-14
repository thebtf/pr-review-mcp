/**
 * Unit tests for InvocationStore — T003 (findByPrAndSince), T006 (smart reap).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { InvocationStore } from './invocation-store.js';

// Open an in-memory SQLite database for each test.
function makeStore(): InvocationStore {
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  const db = new Database(':memory:');

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Minimal schema matching production DDL.
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
    CREATE INDEX idx_invocations_pr ON invocations(owner, repo, pr);
    CREATE INDEX idx_invocations_status ON invocations(status);
    CREATE INDEX idx_invocations_invoked_at ON invocations(invoked_at);

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
// T003 — findByPrAndSince
// ============================================================================

describe('InvocationStore.findByPrAndSince', () => {
  let store: InvocationStore;

  beforeEach(() => {
    store = makeStore();
  });

  it('returns null when no matching row exists', () => {
    const result = store.findByPrAndSince('owner', 'repo', 1, '2026-01-01T00:00:00.000Z');
    expect(result).toBeNull();
  });

  it('returns the invocation when owner/repo/pr/since all match', () => {
    const since = '2026-05-01T10:00:00.000Z';
    const id = store.record({
      owner: 'acme', repo: 'api', pr: 42,
      sessionId: 'sess-1', agents: ['coderabbit'], since,
    });

    const result = store.findByPrAndSince('acme', 'api', 42, since);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(id);
    expect(result!.owner).toBe('acme');
    expect(result!.since).toBe(since);
  });

  it('returns null when since does not match', () => {
    const since = '2026-05-01T10:00:00.000Z';
    store.record({ owner: 'acme', repo: 'api', pr: 42, sessionId: 's', agents: ['coderabbit'], since });

    const result = store.findByPrAndSince('acme', 'api', 42, '2026-06-01T00:00:00.000Z');
    expect(result).toBeNull();
  });

  it('returns the most recent row when duplicates exist across different since values', () => {
    const since1 = '2026-05-01T10:00:00.000Z';
    const since2 = '2026-05-02T10:00:00.000Z';
    store.record({ owner: 'acme', repo: 'api', pr: 1, sessionId: 's1', agents: ['coderabbit'], since: since1 });
    store.record({ owner: 'acme', repo: 'api', pr: 1, sessionId: 's2', agents: ['gemini'], since: since2 });

    const r1 = store.findByPrAndSince('acme', 'api', 1, since1);
    const r2 = store.findByPrAndSince('acme', 'api', 1, since2);
    expect(r1!.agents).toEqual(['coderabbit']);
    expect(r2!.agents).toEqual(['gemini']);
  });
});

// ============================================================================
// T006 — smart reap with per-agent maxWaitMs
// ============================================================================

describe('InvocationStore.reap (smart per-agent maxWaitMs)', () => {
  let store: InvocationStore;

  beforeEach(() => {
    store = makeStore();
  });

  /**
   * Insert a row manually with a specific invoked_at timestamp so we can
   * control age without waiting for real time to pass.
   */
  function insertWithAge(agents: string[], ageMs: number): number {
    const since = new Date(Date.now() - ageMs - 1000).toISOString();
    const invokedAt = new Date(Date.now() - ageMs).toISOString();

    // record() uses now() for invoked_at; we patch it afterward to simulate age.
    const id = store.record({ owner: 'o', repo: 'r', pr: 1, sessionId: 's', agents, since });
    (store as unknown as { db: import('better-sqlite3').Database }).db
      .prepare(`UPDATE invocations SET invoked_at = ? WHERE id = ?`)
      .run(invokedAt, id);
    return id;
  }

  it('marks a CodeRabbit invocation stale after maxWaitMs (12 min) + margin (5 min) has elapsed', () => {
    // CodeRabbit maxWaitMs = 720_000 (12 min). Age = 20 min = well past threshold.
    const id = insertWithAge(['coderabbit'], 20 * 60 * 1000);

    const reaped = store.reap();
    expect(reaped).toBe(1);

    const inv = store.findById(id);
    expect(inv!.status).toBe('stale');
  });

  it('leaves a young invocation (5 min old, CodeRabbit maxWaitMs=12min) as active', () => {
    // Age = 5 min. Threshold = 12 min + 5 min margin = 17 min. Should NOT be reaped.
    const id = insertWithAge(['coderabbit'], 5 * 60 * 1000);

    const reaped = store.reap();
    expect(reaped).toBe(0);

    const inv = store.findById(id);
    expect(inv!.status).toBe('active');
  });

  it('does not reap already-terminal invocations', () => {
    const id = insertWithAge(['coderabbit'], 25 * 60 * 1000);
    // Manually complete it before reaping.
    store.updateStatus(id, 'completed');

    const reaped = store.reap();
    expect(reaped).toBe(0);

    const inv = store.findById(id);
    expect(inv!.status).toBe('completed');
  });

  it('uses the longest maxWaitMs when multiple agents are present', () => {
    // copilot maxWaitMs = 1_800_000 (30 min). Age = 25 min.
    // Even though coderabbit (12 min + 5 margin = 17 min) would trigger,
    // the row uses the MAX across all agents, so 30 min + 5 min = 35 min threshold.
    const id = insertWithAge(['coderabbit', 'copilot'], 25 * 60 * 1000);

    const reaped = store.reap();
    expect(reaped).toBe(0);

    const inv = store.findById(id);
    expect(inv!.status).toBe('active');
  });
});
