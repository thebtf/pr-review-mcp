/**
 * SQLite-backed CoordinationStateManager.
 *
 * Implements the same public interface as CoordinationStateManager but persists
 * partition state to the `coordination` table. Run-level metadata (runId, prInfo,
 * headSha, startedAt, completedAt) and agent tracking are kept in memory because:
 *  - They are short-lived per coordination run.
 *  - On server restart a new run is always initiated; old rows are GC'd by clearExpiredRuns.
 *
 * Nitpick / parent-child methods delegate to state-comment.ts (same as the in-memory
 * implementation) — no change in behaviour.
 *
 * Severity is not stored in the `coordination` table DDL (v1 schema). When reading
 * rows back we default to 'MAJOR'. This is intentional and acceptable: severity is
 * cosmetic for partition ordering and is re-derived from live GitHub data by pr_list /
 * pr_summary at display time.
 */

import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { logger } from '../logging.js';
import {
  registerParentChild as registerParentChildInPR,
  markChildResolved as markChildResolvedInPR,
  isChildResolved as isChildResolvedInPR,
  getParentIdForChild as getParentIdForChildInPR,
  markNitpickResolved as markNitpickResolvedInPR,
  isNitpickResolved as isNitpickResolvedInPR,
} from '../github/state-comment.js';
import type {
  CoordinationState,
  CoordinationStatus,
  FilePartition,
  AgentState,
  PartitionResult,
  OrchestratorProgress,
  OrchestratorPhaseType,
} from './types.js';

// ---------------------------------------------------------------------------
// Row shapes for better-sqlite3 typed queries
// ---------------------------------------------------------------------------

interface CoordinationRow {
  id: number;
  owner: string;
  repo: string;
  pr: number;
  run_id: string;
  session_id: string;
  file: string;
  agent_id: string | null;
  status: string;
  comments: string | null;
  result: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToPartition(row: CoordinationRow): FilePartition {
  let comments: string[] = [];
  if (row.comments) {
    try {
      comments = JSON.parse(row.comments) as string[];
    } catch {
      comments = [];
    }
  }

  let result: PartitionResult | undefined;
  if (row.result) {
    try {
      result = JSON.parse(row.result) as PartitionResult;
    } catch {
      result = undefined;
    }
  }

  return {
    file: row.file,
    comments,
    // Severity is not stored in v1 schema — default to MAJOR (cosmetic only)
    severity: 'MAJOR',
    status: (row.status as FilePartition['status']) || 'pending',
    claimedBy: row.agent_id ?? undefined,
    claimedAt: row.claimed_at ?? undefined,
    result,
  };
}

// ---------------------------------------------------------------------------
// SqliteCoordinationStateManager
// ---------------------------------------------------------------------------

export class SqliteCoordinationStateManager {
  private readonly db: Database.Database;
  private readonly sessionId: string;
  private readonly STALE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
  private static readonly DEFAULT_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

  // Run-level metadata lives in memory (short-lived, rebuilt on restart)
  private runMeta: {
    runId: string;
    prInfo: { owner: string; repo: string; pr: number };
    headSha: string;
    startedAt: string;
    completedAt?: string;
  } | null = null;

  // Agent tracking (in-memory — mirrors DB partition state for performance)
  private agents: Map<string, AgentState> = new Map();

  // Orchestrator progress is purely in-memory (phase transitions within a run)
  private orchestratorProgress: OrchestratorProgress | null = null;

  // Prepared statements (created once, reused)
  private readonly stmtInsertPartition: Database.Statement;
  private readonly stmtClaimPartition: Database.Statement;
  private readonly stmtGetPending: Database.Statement;
  private readonly stmtUpdateStatus: Database.Statement;
  private readonly stmtGetByRun: Database.Statement;
  private readonly stmtDeleteRun: Database.Statement;
  private readonly stmtResetClaimed: Database.Statement;
  private readonly stmtInsertOrMerge: Database.Statement;

  constructor(db: Database.Database, sessionId: string) {
    this.db = db;
    this.sessionId = sessionId;

    this.stmtInsertPartition = this.db.prepare(`
      INSERT OR IGNORE INTO coordination
        (owner, repo, pr, run_id, session_id, file, status, comments, created_at)
      VALUES
        (@owner, @repo, @pr, @run_id, @session_id, @file, 'pending', @comments, @created_at)
    `);

    this.stmtClaimPartition = this.db.prepare(`
      UPDATE coordination
         SET status    = 'claimed',
             agent_id  = @agent_id,
             claimed_at = @claimed_at
       WHERE id = (
         SELECT id FROM coordination
          WHERE run_id = @run_id
            AND status  = 'pending'
            AND agent_id IS NULL
          ORDER BY id
          LIMIT 1
       )
    `);

    this.stmtGetPending = this.db.prepare(`
      SELECT * FROM coordination
       WHERE run_id   = @run_id
         AND status   = 'pending'
         AND agent_id IS NULL
       ORDER BY id
       LIMIT 1
    `);

    this.stmtUpdateStatus = this.db.prepare(`
      UPDATE coordination
         SET status       = @status,
             result       = @result,
             completed_at = @completed_at
       WHERE run_id   = @run_id
         AND file     = @file
         AND agent_id = @agent_id
         AND status   = 'claimed'
    `);

    this.stmtGetByRun = this.db.prepare(`
      SELECT * FROM coordination WHERE run_id = @run_id ORDER BY id
    `);

    this.stmtDeleteRun = this.db.prepare(`
      DELETE FROM coordination WHERE run_id = @run_id
    `);

    this.stmtResetClaimed = this.db.prepare(`
      UPDATE coordination
         SET status     = 'pending',
             agent_id   = NULL,
             claimed_at = NULL
       WHERE run_id     = @run_id
         AND status     = 'claimed'
         AND agent_id   = @agent_id
         AND claimed_at < @cutoff
    `);

    this.stmtInsertOrMerge = this.db.prepare(`
      INSERT INTO coordination
        (owner, repo, pr, run_id, session_id, file, status, comments, created_at)
      VALUES
        (@owner, @repo, @pr, @run_id, @session_id, @file, 'pending', @comments, @created_at)
      ON CONFLICT(run_id, file) DO NOTHING
    `);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getLastActivityTs(): number {
    if (!this.runMeta) return Date.now();
    let lastTs = new Date(this.runMeta.startedAt).getTime();
    for (const agent of this.agents.values()) {
      const ts = new Date(agent.lastSeen).getTime();
      if (Number.isFinite(ts) && ts > lastTs) lastTs = ts;
    }
    return Number.isFinite(lastTs) ? lastTs : Date.now();
  }

  private getOrCreateAgent(agentId: string): AgentState {
    let agent = this.agents.get(agentId);
    if (!agent) {
      agent = {
        agentId,
        claimedFiles: [],
        completedFiles: [],
        lastSeen: new Date().toISOString(),
      };
      this.agents.set(agentId, agent);
    }
    return agent;
  }

  private updateAgentSeen(agentId: string): void {
    const agent = this.getOrCreateAgent(agentId);
    agent.lastSeen = new Date().toISOString();
  }

  /**
   * Load all partitions for the current run from SQLite.
   */
  private loadPartitions(): Map<string, FilePartition> {
    if (!this.runMeta) return new Map();
    const rows = this.stmtGetByRun.all({ run_id: this.runMeta.runId }) as CoordinationRow[];
    const map = new Map<string, FilePartition>();
    for (const row of rows) {
      map.set(row.file, rowToPartition(row));
    }
    return map;
  }

  /**
   * Check if all partitions are terminal (done/failed) and mark run completed.
   */
  private checkCompletion(): void {
    if (!this.runMeta || this.runMeta.completedAt) return;
    const rows = this.stmtGetByRun.all({ run_id: this.runMeta.runId }) as CoordinationRow[];
    if (rows.length === 0) return;
    const allDone = rows.every(r => r.status === 'done' || r.status === 'failed');
    if (allDone) {
      this.runMeta.completedAt = new Date().toISOString();
    }
  }

  // ---------------------------------------------------------------------------
  // Public interface (mirrors CoordinationStateManager exactly)
  // ---------------------------------------------------------------------------

  clearExpiredRuns(maxAgeMs: number = SqliteCoordinationStateManager.DEFAULT_EXPIRY_MS): boolean {
    if (!this.runMeta) return false;
    const inactivity = Date.now() - this.getLastActivityTs();
    if (inactivity > maxAgeMs) {
      logger.warning(
        `[coordination/sqlite] Clearing expired run ${this.runMeta.runId} ` +
          `(inactive: ${Math.round(inactivity / 1000)}s, threshold: ${Math.round(maxAgeMs / 1000)}s)`,
      );
      this.runMeta = null;
      this.agents.clear();
      this.orchestratorProgress = null;
      return true;
    }
    return false;
  }

  initRun(
    prInfo: { owner: string; repo: string; pr: number },
    headSha: string,
    partitions: FilePartition[],
  ): string {
    this.clearExpiredRuns();

    if (this.runMeta) {
      const status = this.runMeta.completedAt ? 'completed' : 'active';
      logger.warning(
        `[coordination/sqlite] Replacing ${status} run ${this.runMeta.runId} for ` +
          `${this.runMeta.prInfo.owner}/${this.runMeta.prInfo.repo}#${this.runMeta.prInfo.pr} ` +
          `with new run for ${prInfo.owner}/${prInfo.repo}#${prInfo.pr}`,
      );
    }

    const runId = randomUUID();
    const now = new Date().toISOString();

    const insertMany = this.db.transaction((parts: FilePartition[]) => {
      for (const p of parts) {
        this.stmtInsertPartition.run({
          owner: prInfo.owner,
          repo: prInfo.repo,
          pr: prInfo.pr,
          run_id: runId,
          session_id: this.sessionId,
          file: p.file,
          comments: JSON.stringify(p.comments ?? []),
          created_at: now,
        });
      }
    });

    insertMany(partitions);

    this.runMeta = { runId, prInfo, headSha, startedAt: now };
    this.agents.clear();
    this.orchestratorProgress = null;

    // Mark completed immediately for empty runs
    this.checkCompletion();

    return runId;
  }

  claimPartition(agentId: string): FilePartition | null {
    this.clearExpiredRuns();
    if (!this.runMeta) return null;

    this.cleanupStaleAgents();
    this.updateAgentSeen(agentId);

    // Atomically grab the first pending unclaimed row via UPDATE … WHERE id = (SELECT …)
    const claimedAt = new Date().toISOString();
    const info = this.stmtClaimPartition.run({
      run_id: this.runMeta.runId,
      agent_id: agentId,
      claimed_at: claimedAt,
    });

    if (info.changes === 0) return null;

    // Fetch the row we just claimed
    const row = (this.db.prepare(
      `SELECT * FROM coordination WHERE run_id = ? AND agent_id = ? AND status = 'claimed' ORDER BY id DESC LIMIT 1`,
    ).get(this.runMeta.runId, agentId)) as CoordinationRow | undefined;

    if (!row) return null;

    const partition = rowToPartition(row);

    // Update in-memory agent tracking
    const agent = this.getOrCreateAgent(agentId);
    agent.claimedFiles.push(partition.file);

    return partition;
  }

  reportProgress(
    agentId: string,
    file: string,
    status: 'done' | 'failed' | 'skipped',
    result?: PartitionResult,
  ): boolean {
    if (!this.runMeta) return false;

    const newStatus = status === 'skipped' ? 'done' : status;
    const now = new Date().toISOString();

    const info = this.stmtUpdateStatus.run({
      run_id: this.runMeta.runId,
      file,
      agent_id: agentId,
      status: newStatus,
      result: result ? JSON.stringify(result) : null,
      completed_at: now,
    });

    if (info.changes === 0) return false;

    this.updateAgentSeen(agentId);

    // Update agent tracking
    const agent = this.getOrCreateAgent(agentId);
    agent.claimedFiles = agent.claimedFiles.filter(f => f !== file);
    agent.completedFiles.push(file);

    this.checkCompletion();
    return true;
  }

  getStatus(): CoordinationStatus {
    if (!this.runMeta) return { active: false };

    const rows = this.stmtGetByRun.all({ run_id: this.runMeta.runId }) as CoordinationRow[];

    const counts = { pending: 0, claimed: 0, done: 0, failed: 0, skipped: 0 };
    for (const row of rows) {
      const s = row.status as keyof typeof counts;
      if (s in counts) counts[s]++;
    }

    const agentsList = Array.from(this.agents.values()).map(a => ({
      agentId: a.agentId,
      claimedCount: a.claimedFiles.length,
      completedCount: a.completedFiles.length,
      lastSeen: a.lastSeen,
    }));

    return {
      active: !this.runMeta.completedAt,
      runId: this.runMeta.runId,
      prInfo: this.runMeta.prInfo,
      progress: counts,
      total: rows.length,
      agents: agentsList,
      startedAt: this.runMeta.startedAt,
      completedAt: this.runMeta.completedAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Nitpick methods — delegate to state-comment.ts (GitHub API)
  // ---------------------------------------------------------------------------

  async markNitpickResolved(
    nitpickId: string,
    agentId: string,
    prInfo?: { owner: string; repo: string; pr: number },
  ): Promise<void> {
    const info = prInfo ?? this.runMeta?.prInfo;
    if (info) {
      try {
        await markNitpickResolvedInPR(info.owner, info.repo, info.pr, nitpickId, agentId);
        return;
      } catch (error) {
        logger.warning('[coordination/sqlite] Failed to mark nitpick resolved in GitHub', error);
      }
    }
    // No local fallback in SQLite implementation — log and swallow
    logger.warning('[coordination/sqlite] markNitpickResolved: no prInfo available, skipping');
  }

  async isNitpickResolved(
    nitpickId: string,
    prInfo?: { owner: string; repo: string; pr: number },
  ): Promise<boolean> {
    const info = prInfo ?? this.runMeta?.prInfo;
    if (info) {
      try {
        return await isNitpickResolvedInPR(info.owner, info.repo, info.pr, nitpickId);
      } catch (error) {
        logger.warning('[coordination/sqlite] Failed to check nitpick resolved in GitHub', error);
      }
    }
    return false;
  }

  async getResolvedNitpicksCount(
    prInfo?: { owner: string; repo: string; pr: number },
  ): Promise<number> {
    const info = prInfo ?? this.runMeta?.prInfo;
    if (!info) return 0;
    try {
      const state = await import('../github/state-comment.js').then(m =>
        m.loadState(info.owner, info.repo, info.pr),
      );
      return Object.keys(state.resolvedNitpicks ?? {}).length;
    } catch {
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Orchestrator progress (in-memory)
  // ---------------------------------------------------------------------------

  updateOrchestratorPhase(phase: OrchestratorPhaseType, detail?: string): void {
    const now = new Date().toISOString();
    const isTerminal = phase === 'complete' || phase === 'error' || phase === 'aborted';

    if (!this.orchestratorProgress || this.orchestratorProgress.completedAt) {
      this.orchestratorProgress = {
        currentPhase: phase,
        detail,
        history: [{ phase, detail, timestamp: now }],
        startedAt: now,
        completedAt: isTerminal ? now : undefined,
      };
    } else {
      this.orchestratorProgress.currentPhase = phase;
      this.orchestratorProgress.detail = detail;
      this.orchestratorProgress.history.push({ phase, detail, timestamp: now });
      if (isTerminal) {
        this.orchestratorProgress.completedAt = now;
      }
    }
  }

  getOrchestratorProgress(): OrchestratorProgress | null {
    return this.orchestratorProgress;
  }

  // ---------------------------------------------------------------------------
  // Parent / child coordination — delegate to state-comment.ts
  // ---------------------------------------------------------------------------

  async registerParentChild(
    parentId: string,
    childIds: string[],
    prInfo: { owner: string; repo: string; pr: number },
  ): Promise<void> {
    await registerParentChildInPR(prInfo.owner, prInfo.repo, prInfo.pr, parentId, childIds);
  }

  async markChildResolved(
    childId: string,
    prInfo: { owner: string; repo: string; pr: number },
  ): Promise<void> {
    await markChildResolvedInPR(prInfo.owner, prInfo.repo, prInfo.pr, childId);
  }

  async isChildResolved(
    childId: string,
    prInfo: { owner: string; repo: string; pr: number },
  ): Promise<boolean> {
    return await isChildResolvedInPR(prInfo.owner, prInfo.repo, prInfo.pr, childId);
  }

  async areAllChildrenResolved(
    parentId: string,
    prInfo: { owner: string; repo: string; pr: number },
  ): Promise<boolean> {
    const state = await import('../github/state-comment.js').then(m =>
      m.loadState(prInfo.owner, prInfo.repo, prInfo.pr),
    );
    const entry = state.parentChildren[parentId];
    if (!entry) return true;
    return Object.values(entry.childStatus).every(s => s === 'resolved');
  }

  async getParentIdForChild(
    childId: string,
    prInfo: { owner: string; repo: string; pr: number },
  ): Promise<string | null> {
    return await getParentIdForChildInPR(prInfo.owner, prInfo.repo, prInfo.pr, childId);
  }

  // ---------------------------------------------------------------------------
  // Stale agent cleanup
  // ---------------------------------------------------------------------------

  cleanupStaleAgents(timeoutMs = this.STALE_TIMEOUT): void {
    if (!this.runMeta) return;

    const now = Date.now();
    const cutoff = new Date(now - timeoutMs).toISOString();

    for (const [agentId, agent] of this.agents.entries()) {
      const lastSeen = new Date(agent.lastSeen).getTime();
      if (now - lastSeen > timeoutMs) {
        // Re-queue claimed partitions in SQLite
        this.stmtResetClaimed.run({
          run_id: this.runMeta.runId,
          agent_id: agentId,
          cutoff,
        });

        // Update in-memory agent tracking
        if (agent.completedFiles.length === 0) {
          this.agents.delete(agentId);
        } else {
          agent.claimedFiles = [];
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Run lifecycle helpers
  // ---------------------------------------------------------------------------

  getCurrentRun(): CoordinationState | null {
    if (!this.runMeta) return null;
    return {
      runId: this.runMeta.runId,
      prInfo: this.runMeta.prInfo,
      headSha: this.runMeta.headSha,
      partitions: this.loadPartitions(),
      agents: new Map(this.agents),
      startedAt: this.runMeta.startedAt,
      completedAt: this.runMeta.completedAt,
    };
  }

  isRunActive(): boolean {
    return this.runMeta !== null && !this.runMeta.completedAt;
  }

  getRunAge(): number | null {
    if (!this.runMeta) return null;
    return Date.now() - new Date(this.runMeta.startedAt).getTime();
  }

  forceComplete(): boolean {
    if (!this.runMeta) return false;
    if (this.runMeta.completedAt) return false;
    this.runMeta.completedAt = new Date().toISOString();
    return true;
  }

  resetRun(): void {
    if (this.runMeta) {
      this.stmtDeleteRun.run({ run_id: this.runMeta.runId });
    }
    this.runMeta = null;
    this.agents.clear();
    this.orchestratorProgress = null;
  }

  addPartitions(partitions: FilePartition[]): number {
    if (!this.runMeta) return 0;

    const existing = this.loadPartitions();
    let touched = 0;
    const now = new Date().toISOString();

    const doWork = this.db.transaction((parts: FilePartition[]) => {
      for (const p of parts) {
        const existing_ = existing.get(p.file);

        if (!existing_) {
          // New partition
          this.stmtInsertOrMerge.run({
            owner: this.runMeta!.prInfo.owner,
            repo: this.runMeta!.prInfo.repo,
            pr: this.runMeta!.prInfo.pr,
            run_id: this.runMeta!.runId,
            session_id: this.sessionId,
            file: p.file,
            comments: JSON.stringify(p.comments ?? []),
            created_at: now,
          });
          touched++;
          continue;
        }

        // Merge comments for existing partition
        const existingSet = new Set(existing_.comments ?? []);
        const incoming = p.comments ?? [];
        let hasNew = false;
        for (const c of incoming) {
          if (!existingSet.has(c)) {
            existingSet.add(c);
            hasNew = true;
          }
        }

        if (hasNew) {
          const shouldReopen =
            existing_.status === 'done' || existing_.status === 'failed';

          if (shouldReopen) {
            this.db.prepare(
              `UPDATE coordination
                  SET comments   = @comments,
                      status     = 'pending',
                      agent_id   = NULL,
                      claimed_at = NULL,
                      result     = NULL
                WHERE run_id = @run_id AND file = @file`,
            ).run({
              run_id: this.runMeta!.runId,
              file: p.file,
              comments: JSON.stringify(Array.from(existingSet)),
            });
          } else {
            this.db.prepare(
              `UPDATE coordination SET comments = @comments WHERE run_id = @run_id AND file = @file`,
            ).run({
              run_id: this.runMeta!.runId,
              file: p.file,
              comments: JSON.stringify(Array.from(existingSet)),
            });
          }
          touched++;
        }
      }
    });

    doWork(partitions);

    // Reopen run if it was completed and new work was added
    if (touched > 0 && this.runMeta.completedAt) {
      logger.warning(
        `[coordination/sqlite] Reopening completed run ${this.runMeta.runId} — added/updated ${touched} partitions`,
      );
      this.runMeta.completedAt = undefined;
    }

    return touched;
  }

  allPartitionsDone(): boolean {
    if (!this.runMeta) return false;
    const rows = this.stmtGetByRun.all({ run_id: this.runMeta.runId }) as CoordinationRow[];
    if (rows.length === 0) return false;
    return rows.every(r => r.status === 'done' || r.status === 'failed');
  }
}
