/**
 * InvocationStore — read/write access to the invocations and agent_status tables.
 *
 * All queries are parameterized (no SQL injection risk).
 * JSON columns are serialized/deserialized transparently.
 * Boolean columns are stored as 0/1 integers.
 * Timestamps are ISO 8601 strings.
 */

import type Database from 'better-sqlite3';
import type { StoredInvocation, StoredAgentStatus } from './types.js';
import type { AgentCompletionResult } from '../agents/completion-detector.js';
import { INVOKABLE_AGENTS, type InvokableAgentId } from '../agents/registry.js';
import { logger } from '../logging.js';

// ============================================================================
// Row shapes returned directly from better-sqlite3
// ============================================================================

interface InvocationRow {
  id: number;
  owner: string;
  repo: string;
  pr: number;
  session_id: string;
  agents: string;
  since: string;
  invoked_at: string;
  status: string;
  completed_at: string | null;
  result: string | null;
}

interface AgentStatusRow {
  id: number;
  invocation_id: number;
  agent_id: string;
  ready: number;
  confidence: string | null;
  source: string | null;
  last_activity: string | null;
  timed_out: number;
  detail: string | null;
  checked_at: string;
}

// ============================================================================
// Mappers
// ============================================================================

function rowToInvocation(row: InvocationRow): StoredInvocation {
  return {
    id: row.id,
    owner: row.owner,
    repo: row.repo,
    pr: row.pr,
    sessionId: row.session_id,
    agents: JSON.parse(row.agents) as string[],
    since: row.since,
    invokedAt: row.invoked_at,
    status: row.status as StoredInvocation['status'],
    completedAt: row.completed_at,
    result: row.result !== null ? (JSON.parse(row.result) as object) : null,
  };
}

function rowToAgentStatus(row: AgentStatusRow): StoredAgentStatus {
  return {
    id: row.id,
    invocationId: row.invocation_id,
    agentId: row.agent_id,
    ready: row.ready === 1,
    confidence: row.confidence,
    source: row.source,
    lastActivity: row.last_activity,
    timedOut: row.timed_out === 1,
    detail: row.detail,
    checkedAt: row.checked_at,
  };
}

// ============================================================================
// InvocationStore
// ============================================================================

export class InvocationStore {
  private readonly stmtInsertInvocation: Database.Statement;
  private readonly stmtInsertAgentStatus: Database.Statement;
  private readonly stmtFindActive: Database.Statement<[string, string, number]>;
  private readonly stmtFindByPrAndSince: Database.Statement<[string, string, number, string]>;
  private readonly stmtFindById: Database.Statement<[number]>;
  private readonly stmtGetAgentStatuses: Database.Statement<[number]>;
  private readonly stmtUpdateStatus: Database.Statement;
  // stmtReap kept for reference; reap() uses a JS-driven approach for per-agent maxWaitMs
  private readonly stmtReap: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.stmtInsertInvocation = db.prepare(`
      INSERT INTO invocations (owner, repo, pr, session_id, agents, since, invoked_at, status)
      VALUES (@owner, @repo, @pr, @sessionId, @agents, @since, @invokedAt, 'active')
      ON CONFLICT(owner, repo, pr, since) DO NOTHING
    `);

    this.stmtInsertAgentStatus = db.prepare(`
      INSERT INTO agent_status
        (invocation_id, agent_id, ready, confidence, source, last_activity, timed_out, detail, checked_at)
      VALUES
        (@invocationId, @agentId, 0, NULL, NULL, NULL, 0, NULL, @checkedAt)
      ON CONFLICT(invocation_id, agent_id) DO NOTHING
    `);

    this.stmtFindActive = db.prepare<[string, string, number], InvocationRow>(`
      SELECT * FROM invocations
      WHERE owner = ? AND repo = ? AND pr = ? AND status = 'active'
      ORDER BY invoked_at DESC
      LIMIT 1
    `);

    this.stmtFindByPrAndSince = db.prepare<[string, string, number, string], InvocationRow>(`
      SELECT * FROM invocations
      WHERE owner = ? AND repo = ? AND pr = ? AND since = ?
      ORDER BY invoked_at DESC
      LIMIT 1
    `);

    this.stmtFindById = db.prepare<[number], InvocationRow>(`
      SELECT * FROM invocations WHERE id = ?
    `);

    this.stmtGetAgentStatuses = db.prepare<[number], AgentStatusRow>(`
      SELECT * FROM agent_status WHERE invocation_id = ?
    `);

    this.stmtUpdateStatus = db.prepare(`
      UPDATE invocations
      SET status = @status,
          completed_at = @completedAt,
          result = @result
      WHERE id = @id
    `);

    this.stmtReap = db.prepare(`
      UPDATE invocations
      SET status = 'stale'
      WHERE status = 'active'
        AND invoked_at < datetime('now', '-30 minutes')
    `);
  }

  // ============================================================================
  // Writes
  // ============================================================================

  /**
   * Record a new invocation and initialize agent_status rows.
   * Uses a transaction so both inserts are atomic.
   * Deduplication: if (owner, repo, pr, since) already exists, returns the existing id.
   * Returns the invocation id (existing or newly created).
   */
  record(params: {
    owner: string;
    repo: string;
    pr: number;
    sessionId: string;
    agents: string[];
    since: string;
  }): number {
    const now = new Date().toISOString();

    const runTransaction = this.db.transaction((): number => {
      this.stmtInsertInvocation.run({
        owner: params.owner,
        repo: params.repo,
        pr: params.pr,
        sessionId: params.sessionId,
        agents: JSON.stringify(params.agents),
        since: params.since,
        invokedAt: now,
      });

      // Fetch the id whether we just inserted or it already existed.
      const row = this.db
        .prepare(
          `SELECT id FROM invocations WHERE owner = ? AND repo = ? AND pr = ? AND since = ?`,
        )
        .get(params.owner, params.repo, params.pr, params.since) as { id: number } | undefined;

      if (row === undefined) {
        throw new Error('Failed to resolve invocation id after INSERT');
      }

      for (const agentId of params.agents) {
        this.stmtInsertAgentStatus.run({
          invocationId: row.id,
          agentId,
          checkedAt: now,
        });
      }

      return row.id;
    });

    return runTransaction();
  }

  /**
   * Upsert agent completion results and update the parent invocation status
   * if all agents have settled.
   *
   * Accepts either plain `AgentCompletionResult` objects (from the completion detector)
   * or augmented objects that include the `timedOut` flag (from `pr_await_reviews`, which
   * computes per-agent timeouts based on elapsed wall-clock time).
   */
  updateAgentStatus(
    invocationId: number,
    agents: (AgentCompletionResult & { timedOut?: boolean })[],
  ): void {
    const now = new Date().toISOString();

    const upsertAgent = this.db.prepare(`
      INSERT INTO agent_status
        (invocation_id, agent_id, ready, confidence, source, last_activity, timed_out, detail, checked_at)
      VALUES
        (@invocationId, @agentId, @ready, @confidence, @source, @lastActivity, @timedOut, @detail, @checkedAt)
      ON CONFLICT(invocation_id, agent_id) DO UPDATE SET
        ready         = excluded.ready,
        confidence    = excluded.confidence,
        source        = excluded.source,
        last_activity = excluded.last_activity,
        timed_out     = excluded.timed_out,
        detail        = excluded.detail,
        checked_at    = excluded.checked_at
    `);

    const runTransaction = this.db.transaction(() => {
      for (const agent of agents) {
        upsertAgent.run({
          invocationId,
          agentId: agent.agentId,
          ready: agent.ready ? 1 : 0,
          confidence: agent.confidence ?? null,
          source: agent.source ?? null,
          lastActivity: agent.lastActivity ?? null,
          timedOut: (agent.timedOut ?? false) ? 1 : 0,
          detail: agent.detail ?? null,
          checkedAt: now,
        });
      }

      // Derive invocation status from settled agents.
      const allStatuses = this.stmtGetAgentStatuses.all(invocationId) as AgentStatusRow[];
      const readyCount = allStatuses.filter(r => r.ready === 1).length;
      const timedOutCount = allStatuses.filter(r => r.timed_out === 1).length;
      const settledCount = readyCount + timedOutCount;

      if (settledCount < allStatuses.length) {
        return; // Some agents still pending — don't update invocation status yet.
      }

      let status: StoredInvocation['status'];
      if (timedOutCount === 0) {
        status = 'completed';
      } else if (readyCount > 0) {
        status = 'partial';
      } else {
        status = 'timed_out';
      }

      this.stmtUpdateStatus.run({
        id: invocationId,
        status,
        completedAt: now,
        result: null,
      });
    });

    runTransaction();
  }

  /**
   * Explicitly set invocation status (e.g., after pr_await_reviews returns a final result).
   */
  updateInvocationStatus(invocationId: number, status: string, result?: object): void {
    const now = new Date().toISOString();
    const isTerminal = ['completed', 'partial', 'timed_out', 'stale', 'cancelled'].includes(status);

    this.stmtUpdateStatus.run({
      id: invocationId,
      status,
      completedAt: isTerminal ? now : null,
      result: result !== undefined ? JSON.stringify(result) : null,
    });
  }

  /**
   * Convenience alias for updateInvocationStatus — used by pr_cancel and merged-PR short-circuit.
   */
  updateStatus(id: number, status: string, result?: object): void {
    this.updateInvocationStatus(id, status, result);
  }

  /**
   * Explicitly complete an invocation with a terminal status and an optional string result tag.
   * Convenience wrapper used by the merged-PR short-circuit path.
   */
  completeInvocation(id: number, status: string, resultTag: string): void {
    this.updateInvocationStatus(id, status, { tag: resultTag });
  }

  // ============================================================================
  // Reads
  // ============================================================================

  /**
   * Find the most recent active invocation for a PR.
   * Returns null if none found (caller should prompt user to run pr_invoke first).
   */
  findActiveForPR(owner: string, repo: string, pr: number): StoredInvocation | null {
    const row = this.stmtFindActive.get(owner, repo, pr) as InvocationRow | undefined;
    return row !== undefined ? rowToInvocation(row) : null;
  }

  /**
   * Find the most recent invocation matching (owner, repo, pr, since).
   * Used by pr_await_reviews to bind explicit-since callers to a stored invocation.
   */
  findByPrAndSince(owner: string, repo: string, pr: number, since: string): StoredInvocation | null {
    const row = this.stmtFindByPrAndSince.get(owner, repo, pr, since) as InvocationRow | undefined;
    return row !== undefined ? rowToInvocation(row) : null;
  }

  /**
   * Find an invocation by its primary key.
   */
  findById(id: number): StoredInvocation | null {
    const row = this.stmtFindById.get(id) as InvocationRow | undefined;
    return row !== undefined ? rowToInvocation(row) : null;
  }

  /**
   * List invocations matching the given filter. Defaults to last 50 entries.
   */
  listSessions(filter: {
    owner?: string;
    repo?: string;
    pr?: number;
    status?: string;
    limit?: number;
  }): StoredInvocation[] {
    const conditions: string[] = [];
    const values: (string | number)[] = [];

    if (filter.owner !== undefined) {
      conditions.push('owner = ?');
      values.push(filter.owner);
    }
    if (filter.repo !== undefined) {
      conditions.push('repo = ?');
      values.push(filter.repo);
    }
    if (filter.pr !== undefined) {
      conditions.push('pr = ?');
      values.push(filter.pr);
    }
    if (filter.status !== undefined && filter.status !== 'all') {
      conditions.push('status = ?');
      values.push(filter.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit ?? 50;

    const rows = this.db
      .prepare<(string | number)[], InvocationRow>(
        `SELECT * FROM invocations ${where} ORDER BY invoked_at DESC LIMIT ${limit}`,
      )
      .all(...values);

    return rows.map(rowToInvocation);
  }

  /**
   * Retrieve all agent status rows for an invocation.
   */
  getAgentStatuses(invocationId: number): StoredAgentStatus[] {
    return (this.stmtGetAgentStatuses.all(invocationId) as AgentStatusRow[]).map(rowToAgentStatus);
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Mark active invocations that have exceeded their per-agent maxWaitMs as stale.
   * Uses a JS-driven approach to apply the correct timeout per agent (instead of a
   * fixed SQL 30-minute threshold), with a 5-minute margin added on top.
   *
   * Returns the number of rows updated.
   */
  reap(): number {
    const MARGIN_MS = 5 * 60 * 1000;   // 5 min grace margin
    const DEFAULT_MAX_WAIT = 600_000;   // 10 min fallback

    const activeRows = this.db
      .prepare<[], InvocationRow>(`SELECT * FROM invocations WHERE status = 'active'`)
      .all();

    if (activeRows.length === 0) return 0;

    const now = Date.now();
    const markStale = this.db.prepare(`UPDATE invocations SET status = 'stale' WHERE id = ?`);
    let reaped = 0;

    const runTransaction = this.db.transaction(() => {
      for (const row of activeRows) {
        const agents = JSON.parse(row.agents) as string[];
        const maxWait = agents.reduce((acc, agentId) => {
          const config = INVOKABLE_AGENTS[agentId as InvokableAgentId];
          return Math.max(acc, config?.completionStrategy.maxWaitMs ?? DEFAULT_MAX_WAIT);
        }, DEFAULT_MAX_WAIT);

        const age = now - new Date(row.invoked_at).getTime();
        if (age > maxWait + MARGIN_MS) {
          markStale.run(row.id);
          reaped++;
        }
      }
    });

    runTransaction();

    if (reaped > 0) {
      logger.info(`Reaper marked ${reaped} stale invocation(s)`);
    }
    return reaped;
  }

  /**
   * Delete expired records and run a WAL checkpoint.
   * Returns the total number of deleted rows.
   */
  gc(): number {
    const deleteTerminal = this.db.prepare(`
      DELETE FROM invocations
      WHERE status IN ('completed', 'partial', 'timed_out', 'cancelled')
        AND invoked_at < datetime('now', '-7 days')
    `);

    const deleteStale = this.db.prepare(`
      DELETE FROM invocations
      WHERE status = 'stale'
        AND invoked_at < datetime('now', '-1 day')
    `);

    const deleteCoordination = this.db.prepare(`
      DELETE FROM coordination
      WHERE created_at < datetime('now', '-1 day')
    `);

    const runGc = this.db.transaction((): number => {
      const r1 = deleteTerminal.run();
      const r2 = deleteStale.run();
      const r3 = deleteCoordination.run();
      return r1.changes + r2.changes + r3.changes;
    });

    const total = runGc();

    // Checkpoint the WAL file to keep disk usage bounded.
    this.db.pragma('wal_checkpoint(TRUNCATE)');

    // Record GC timestamp.
    this.db
      .prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_gc', ?)`)
      .run(new Date().toISOString());

    if (total > 0) {
      logger.info(`GC deleted ${total} expired record(s)`);
    }

    return total;
  }
}
