/**
 * SQLite database initialization and schema migrations for PR review persistence.
 *
 * Database location: ~/.config/pr-review/pr-review.db
 * Falls back to null (in-memory Map fallback) if better-sqlite3 fails to load (NFR-4).
 */

import { mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../logging.js';

const DB_DIR = join(homedir(), '.config', 'pr-review');
const DB_PATH = join(DB_DIR, 'pr-review.db');
const SCHEMA_VERSION = 1;

// ============================================================================
// DDL
// ============================================================================

const DDL_INVOCATIONS = `
CREATE TABLE IF NOT EXISTS invocations (
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
CREATE INDEX IF NOT EXISTS idx_invocations_pr ON invocations(owner, repo, pr);
CREATE INDEX IF NOT EXISTS idx_invocations_status ON invocations(status);
CREATE INDEX IF NOT EXISTS idx_invocations_invoked_at ON invocations(invoked_at);
`;

const DDL_AGENT_STATUS = `
CREATE TABLE IF NOT EXISTS agent_status (
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
`;

const DDL_COORDINATION = `
CREATE TABLE IF NOT EXISTS coordination (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  owner          TEXT NOT NULL,
  repo           TEXT NOT NULL,
  pr             INTEGER NOT NULL,
  run_id         TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  file           TEXT NOT NULL,
  agent_id       TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  comments       TEXT,
  result         TEXT,
  claimed_at     TEXT,
  completed_at   TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE(run_id, file)
);
CREATE INDEX IF NOT EXISTS idx_coordination_run ON coordination(run_id);
CREATE INDEX IF NOT EXISTS idx_coordination_pr ON coordination(owner, repo, pr);
`;

const DDL_METADATA = `
CREATE TABLE IF NOT EXISTS metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// ============================================================================
// Public API
// ============================================================================

/**
 * Open the SQLite database at ~/.config/pr-review/pr-review.db.
 * Returns null if better-sqlite3 fails to load (native binary issue, disk error, etc.).
 * Caller should fall back to in-memory storage when null is returned.
 */
export function openDatabase(): import('better-sqlite3').Database | null {
  try {
    mkdirSync(DB_DIR, { recursive: true });

    // Dynamic require so that a load failure can be caught and handled gracefully.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const db = new Database(DB_PATH);

    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');

    runMigrations(db);

    return db;
  } catch (err) {
    logger.warning('SQLite unavailable — falling back to in-memory storage', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ============================================================================
// Migrations
// ============================================================================

function runMigrations(db: import('better-sqlite3').Database): void {
  const row = db
    .prepare<[], { value: string }>(`SELECT value FROM metadata WHERE key = 'schema_version'`)
    .get();

  if (row === undefined) {
    // First-time setup: create all tables and record the schema version.
    db.exec(DDL_INVOCATIONS);
    db.exec(DDL_AGENT_STATUS);
    db.exec(DDL_COORDINATION);
    db.exec(DDL_METADATA);

    db.prepare(`INSERT INTO metadata (key, value) VALUES ('schema_version', ?)`).run(
      String(SCHEMA_VERSION),
    );

    logger.info(`SQLite schema created at version ${SCHEMA_VERSION}`, { path: DB_PATH });
    return;
  }

  const currentVersion = parseInt(row.value, 10);

  if (currentVersion < SCHEMA_VERSION) {
    // Future migrations go here:
    // if (currentVersion < 2) { ... db.exec(...); }
    db.prepare(`UPDATE metadata SET value = ? WHERE key = 'schema_version'`).run(
      String(SCHEMA_VERSION),
    );
    logger.info(`SQLite schema migrated to version ${SCHEMA_VERSION}`);
  }
}
