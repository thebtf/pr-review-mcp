/**
 * Unit tests for prCancel tool — T008.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { InvocationStore } from '../persistence/invocation-store.js';
import { prCancel } from './cancel.js';

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

describe('prCancel', () => {
  let store: InvocationStore;
  let activeId: number;

  beforeEach(() => {
    store = makeStore();
    activeId = store.record({
      owner: 'acme', repo: 'api', pr: 7,
      sessionId: 'sess', agents: ['coderabbit'],
      since: new Date().toISOString(),
    });
  });

  it('returns error when no matching invocation exists', () => {
    const result = prCancel({ owner: 'nobody', repo: 'nowhere', pr: 999 }, store);
    expect(result.cancelled).toBe(false);
    expect(result.error).toMatch(/no matching/i);
  });

  it('cancels an active invocation by (owner, repo, pr)', () => {
    const result = prCancel({ owner: 'acme', repo: 'api', pr: 7 }, store);
    expect(result.cancelled).toBe(true);
    expect(result.invocationId).toBe(activeId);

    const inv = store.findById(activeId);
    expect(inv!.status).toBe('cancelled');
  });

  it('cancels an active invocation by invocationId', () => {
    const result = prCancel({ invocationId: activeId }, store);
    expect(result.cancelled).toBe(true);
    expect(result.invocationId).toBe(activeId);

    const inv = store.findById(activeId);
    expect(inv!.status).toBe('cancelled');
  });

  it('returns alreadyTerminal when invocation is already completed', () => {
    store.updateStatus(activeId, 'completed');

    const result = prCancel({ invocationId: activeId }, store);
    expect(result.cancelled).toBe(false);
    expect(result.alreadyTerminal).toBe(true);
    expect(result.status).toBe('completed');

    // Status must not have been altered.
    const inv = store.findById(activeId);
    expect(inv!.status).toBe('completed');
  });

  it('returns alreadyTerminal for timed_out invocation', () => {
    store.updateStatus(activeId, 'timed_out');
    const result = prCancel({ invocationId: activeId }, store);
    expect(result.cancelled).toBe(false);
    expect(result.alreadyTerminal).toBe(true);
    expect(result.status).toBe('timed_out');
  });

  it('returns alreadyTerminal for already-cancelled invocation (idempotent)', () => {
    store.updateStatus(activeId, 'cancelled');
    const result = prCancel({ invocationId: activeId }, store);
    expect(result.cancelled).toBe(false);
    expect(result.alreadyTerminal).toBe(true);
    expect(result.status).toBe('cancelled');
  });

  it('rejects input missing both invocationId and (owner, repo, pr)', () => {
    expect(() => prCancel({} as never, store)).toThrow();
  });
});
