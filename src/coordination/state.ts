import { randomUUID } from 'crypto';
import path from 'path';
import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { logger } from '../logging.js';
import {
  registerParentChild as registerParentChildInPR,
  markChildResolved as markChildResolvedInPR,
  isChildResolved as isChildResolvedInPR,
  getParentIdForChild as getParentIdForChildInPR,
  markNitpickResolved as markNitpickResolvedInPR,
  isNitpickResolved as isNitpickResolvedInPR
} from '../github/state-comment.js';
import type {
  CoordinationState,
  FilePartition,
  AgentState,
  PartitionResult,
  NitpickResolution,
  ParentChildEntry,
  OrchestratorProgress,
  OrchestratorPhaseType
} from './types.js';

/**
 * CoordinationStateManager - Singleton manager for parallel PR review coordination
 *
 * Design decisions:
 * - Singleton pattern: Ensures single source of truth for coordination state across the MCP server
 * - In-memory state: Simple, fast, suitable for short-lived coordination runs
 * - Thread safety: JavaScript event loop guarantees atomicity for synchronous operations.
 *   While multiple async MCP calls may be in-flight, each call to claimPartition/reportProgress
 *   executes synchronously without interleaving, preventing race conditions.
 * - Stale agent cleanup: Re-queues work from agents that haven't reported activity within STALE_TIMEOUT
 *
 * Lifecycle:
 * 1. initRun() - Creates new coordination run, replacing any previous run (completed or not)
 * 2. claimPartition() - Agents atomically claim pending work
 * 3. reportProgress() - Agents report completion with strict ownership validation
 * 4. Auto-completion when all partitions are done/failed
 */
class CoordinationStateManager {
  private currentRun: CoordinationState | null = null;
  private readonly STALE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
  private resolvedNitpicks: Map<string, NitpickResolution> = new Map();
  private nitpicksLoaded: boolean = false;
  private currentPrKey: string | null = null;
  private orchestratorProgress: OrchestratorProgress | null = null;

  /**
   * Initialize a new coordination run
   * Note: This replaces any existing run (completed or not) without explicit cleanup
   */
  initRun(
    prInfo: { owner: string; repo: string; pr: number },
    headSha: string,
    partitions: FilePartition[]
  ): string {
    if (this.currentRun) {
      const status = this.currentRun.completedAt ? 'completed' : 'active';
      logger.warning(
        `[coordination] Replacing ${status} run ${this.currentRun.runId} for ` +
        `${this.currentRun.prInfo.owner}/${this.currentRun.prInfo.repo}#${this.currentRun.prInfo.pr} ` +
        `with new run for ${prInfo.owner}/${prInfo.repo}#${prInfo.pr}`
      );
    }

    const runId = randomUUID();
    const partitionsMap = new Map<string, FilePartition>();

    partitions.forEach(p => {
      partitionsMap.set(p.file, { ...p, status: 'pending' });
    });

    this.currentRun = {
      runId,
      prInfo,
      headSha,
      partitions: partitionsMap,
      agents: new Map(),
      startedAt: new Date().toISOString()
    };

    // Mark as completed immediately if no partitions (empty PR)
    this.checkCompletion();

    return runId;
  }

  /**
   * Atomically claim the next pending partition for an agent
   */
  claimPartition(agentId: string): FilePartition | null {
    if (!this.currentRun) return null;

    this.cleanupStaleAgents();
    this.updateAgentSeen(agentId);

    // Find first pending partition
    for (const [file, partition] of this.currentRun.partitions.entries()) {
      if (partition.status === 'pending') {
        // Atomic claim
        const updatedPartition: FilePartition = {
          ...partition,
          status: 'claimed',
          claimedBy: agentId,
          claimedAt: new Date().toISOString()
        };
        this.currentRun.partitions.set(file, updatedPartition);

        // Update agent state
        const agent = this.getOrCreateAgent(agentId);
        agent.claimedFiles.push(file);

        return updatedPartition;
      }
    }

    return null;
  }

  /**
   * Report progress on a partition
   * Note: 'skipped' status is converted to 'done' for completion tracking
   */
  reportProgress(
    agentId: string,
    file: string,
    status: 'done' | 'failed' | 'skipped',
    result?: PartitionResult
  ): boolean {
    if (!this.currentRun) return false;

    const partition = this.currentRun.partitions.get(file);
    if (!partition) return false;

    // Strict ownership check: partition must be claimed by this agent
    // Prevents marking unclaimed/re-queued partitions as done
    if (partition.status !== 'claimed' || partition.claimedBy !== agentId) {
      return false;
    }

    // Convert 'skipped' to 'done' for completion tracking
    // This simplifies checkCompletion logic but loses skip vs. complete distinction
    const newStatus = status === 'skipped' ? 'done' : status;

    const updatedPartition: FilePartition = {
      ...partition,
      status: newStatus,
      result
    };

    this.currentRun.partitions.set(file, updatedPartition);
    this.updateAgentSeen(agentId);

    // Update agent state
    const agent = this.getOrCreateAgent(agentId);
    // Remove from claimed
    agent.claimedFiles = agent.claimedFiles.filter(f => f !== file);
    // Add to completed
    agent.completedFiles.push(file);

    this.checkCompletion();

    return true;
  }

  /**
   * Get current status summary
   */
  getStatus() {
    if (!this.currentRun) {
      return { active: false };
    }

    const counts = {
      pending: 0,
      claimed: 0,
      done: 0,
      failed: 0,
      skipped: 0
    };

    for (const p of this.currentRun.partitions.values()) {
      counts[p.status]++;
    }

    // Convert Maps to objects/arrays for serialization
    const agentsList = Array.from(this.currentRun.agents.values()).map(a => ({
        agentId: a.agentId,
        claimedCount: a.claimedFiles.length,
        completedCount: a.completedFiles.length,
        lastSeen: a.lastSeen
    }));

    return {
      active: !this.currentRun.completedAt, // active only if not completed
      runId: this.currentRun.runId,
      prInfo: this.currentRun.prInfo,
      progress: counts,
      total: this.currentRun.partitions.size,
      agents: agentsList,
      startedAt: this.currentRun.startedAt,
      completedAt: this.currentRun.completedAt
    };
  }

  async markNitpickResolved(
    nitpickId: string,
    agentId: string,
    prInfo?: { owner: string; repo: string; pr: number }
  ): Promise<void> {
    // Prefer GitHub state-comment API
    if (prInfo) {
      try {
        await markNitpickResolvedInPR(prInfo.owner, prInfo.repo, prInfo.pr, nitpickId, agentId);
        return;
      } catch (error) {
        logger.warning('[state] Failed to mark nitpick resolved in GitHub, falling back to local', error);
      }
    }

    // Fallback to local persistence
    await this.ensureNitpicksLoaded(prInfo);
    this.resolvedNitpicks.set(nitpickId, {
      resolvedAt: new Date().toISOString(),
      resolvedBy: agentId
    });
    await this.persistNitpicksAsync(prInfo);
  }

  async isNitpickResolved(
    nitpickId: string,
    prInfo?: { owner: string; repo: string; pr: number }
  ): Promise<boolean> {
    // Prefer GitHub state-comment API
    if (prInfo) {
      try {
        return await isNitpickResolvedInPR(prInfo.owner, prInfo.repo, prInfo.pr, nitpickId);
      } catch (error) {
        logger.warning('[state] Failed to check nitpick resolved in GitHub, falling back to local', error);
      }
    }

    // Fallback to local persistence
    await this.ensureNitpicksLoaded(prInfo);
    return this.resolvedNitpicks.has(nitpickId);
  }

  async getResolvedNitpicksCount(prInfo?: { owner: string; repo: string; pr: number }): Promise<number> {
    await this.ensureNitpicksLoaded(prInfo);
    return this.resolvedNitpicks.size;
  }

  // --- Orchestrator Progress ---

  updateOrchestratorPhase(phase: OrchestratorPhaseType, detail?: string): void {
    const now = new Date().toISOString();
    const isTerminal = phase === 'complete' || phase === 'error' || phase === 'aborted';
    if (!this.orchestratorProgress) {
      this.orchestratorProgress = {
        currentPhase: phase,
        detail,
        history: [{ phase, detail, timestamp: now }],
        startedAt: now,
        completedAt: isTerminal ? now : undefined
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

  // --- Parent/Child Coordination ---

  async registerParentChild(
    parentId: string,
    childIds: string[],
    prInfo: { owner: string; repo: string; pr: number }
  ): Promise<void> {
    await registerParentChildInPR(prInfo.owner, prInfo.repo, prInfo.pr, parentId, childIds);
  }

  async markChildResolved(
    childId: string,
    prInfo: { owner: string; repo: string; pr: number }
  ): Promise<void> {
    await markChildResolvedInPR(prInfo.owner, prInfo.repo, prInfo.pr, childId);
  }

  async isChildResolved(
    childId: string,
    prInfo: { owner: string; repo: string; pr: number }
  ): Promise<boolean> {
    return await isChildResolvedInPR(prInfo.owner, prInfo.repo, prInfo.pr, childId);
  }

  async areAllChildrenResolved(
    parentId: string,
    prInfo: { owner: string; repo: string; pr: number }
  ): Promise<boolean> {
    // Check each child's status - we need to get the parent entry to know which children exist
    const state = await import('../github/state-comment.js').then(m => m.loadState(prInfo.owner, prInfo.repo, prInfo.pr));
    const entry = state.parentChildren[parentId];

    if (!entry) return true; // Treat unknown parents as fully resolved (fallback)

    return Object.values(entry.childStatus).every(status => status === 'resolved');
  }

  async getParentIdForChild(
    childId: string,
    prInfo: { owner: string; repo: string; pr: number }
  ): Promise<string | null> {
    return await getParentIdForChildInPR(prInfo.owner, prInfo.repo, prInfo.pr, childId);
  }

  /**
   * Re-queue partitions from stale agents and remove idle stale agents
   */
  cleanupStaleAgents(timeoutMs = this.STALE_TIMEOUT) {
    if (!this.currentRun) return;

    const now = new Date().getTime();

    for (const [agentId, agent] of this.currentRun.agents.entries()) {
      const lastSeen = new Date(agent.lastSeen).getTime();
      if (now - lastSeen > timeoutMs) {
        // Agent is stale. Re-queue its claimed files.
        for (const file of agent.claimedFiles) {
            const partition = this.currentRun.partitions.get(file);
            if (partition && partition.status === 'claimed' && partition.claimedBy === agentId) {
                this.currentRun.partitions.set(file, {
                    ...partition,
                    status: 'pending',
                    claimedBy: undefined,
                    claimedAt: undefined
                });
            }
        }

        // Remove stale agent from map if it has no completed work
        // Agents with completed work are retained for status reporting
        if (agent.completedFiles.length === 0) {
          this.currentRun.agents.delete(agentId);
        } else {
          agent.claimedFiles = [];
        }
      }
    }
  }

  // --- Helpers ---

  private getOrCreateAgent(agentId: string): AgentState {
    if (!this.currentRun) throw new Error("No active run");
    
    let agent = this.currentRun.agents.get(agentId);
    if (!agent) {
        agent = {
            agentId,
            claimedFiles: [],
            completedFiles: [],
            lastSeen: new Date().toISOString()
        };
        this.currentRun.agents.set(agentId, agent);
    }
    return agent;
  }

  private updateAgentSeen(agentId: string) {
      const agent = this.getOrCreateAgent(agentId);
      agent.lastSeen = new Date().toISOString();
  }

  private checkCompletion() {
      if (!this.currentRun) return;
      if (this.currentRun.completedAt) return;

      const allDone = Array.from(this.currentRun.partitions.values()).every(p => 
          p.status === 'done' || p.status === 'failed'
      );

      if (allDone) {
          this.currentRun.completedAt = new Date().toISOString();
      }
  }

  private getPrKey(prInfo?: { owner: string; repo: string; pr: number }): string {
    const info = prInfo || this.currentRun?.prInfo;
    if (!info) {
      return 'unknown';
    }
    return `${info.owner}-${info.repo}-${info.pr}`;
  }

  private async persistAllForCurrentPr(): Promise<void> {
    if (!this.currentPrKey || this.currentPrKey === 'unknown') return;

    const parts = this.currentPrKey.split('-');
    const prStr = parts.pop();
    const repo = parts.pop();
    const owner = parts.join('-');
    const oldPrInfo = owner && repo && prStr
      ? { owner, repo, pr: parseInt(prStr, 10) }
      : undefined;

    if (this.nitpicksLoaded) {
      await this.persistNitpicksAsync(oldPrInfo);
    }
  }

  private getNitpicksPath(prInfo?: { owner: string; repo: string; pr: number }): string {
    const prKey = this.getPrKey(prInfo);
    return path.join(process.cwd(), '.agent', 'status', `nitpicks-${prKey}.json`);
  }

  private async ensureNitpicksLoaded(prInfo?: { owner: string; repo: string; pr: number }): Promise<void> {
    const prKey = this.getPrKey(prInfo);
    if (this.nitpicksLoaded && this.currentPrKey === prKey) return;

    if (this.currentPrKey && this.currentPrKey !== prKey) {
      await this.persistAllForCurrentPr();
      this.nitpicksLoaded = false;
    }

    const filePath = this.getNitpicksPath(prInfo);
    if (existsSync(filePath)) {
      try {
        const data = await readFile(filePath, 'utf-8');
        const parsed = JSON.parse(data);
        this.resolvedNitpicks = new Map(Object.entries(parsed));
      } catch {
        this.resolvedNitpicks = new Map();
      }
    } else {
      this.resolvedNitpicks = new Map();
    }
    this.nitpicksLoaded = true;
    this.currentPrKey = prKey;
  }

  private async persistNitpicksAsync(prInfo?: { owner: string; repo: string; pr: number }): Promise<void> {
    const filePath = this.getNitpicksPath(prInfo);
    const dir = path.dirname(filePath);

    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    // Atomic write via temp file
    const tempPath = `${filePath}.tmp`;
    const data = JSON.stringify(Object.fromEntries(this.resolvedNitpicks), null, 2);
    await writeFile(tempPath, data, 'utf-8');
    await rename(tempPath, filePath);
  }

  public getCurrentRun() {
    return this.currentRun;
  }

  /**
   * Check if there's an active (non-completed) run
   */
  isRunActive(): boolean {
    return this.currentRun !== null && !this.currentRun.completedAt;
  }

  /**
   * Get run age in milliseconds (or null if no run)
   */
  getRunAge(): number | null {
    if (!this.currentRun) return null;
    return Date.now() - new Date(this.currentRun.startedAt).getTime();
  }

  /**
   * Force complete the current run
   * Useful for testing and emergency stop scenarios
   */
  forceComplete(): boolean {
    if (!this.currentRun) return false;
    if (this.currentRun.completedAt) return false;

    this.currentRun.completedAt = new Date().toISOString();
    return true;
  }

  /**
   * Reset/clear the current run
   * Useful for testing and explicit cleanup
   */
  resetRun(): void {
    this.currentRun = null;
    this.orchestratorProgress = null;
  }

  /**
   * Add new partitions to an existing run (for dynamic partition refresh)
   * Merges new comments into existing file partitions or creates new partitions
   * Reopens the run if it was completed and work was added/updated
   * @returns Number of partitions touched (added or updated with new comments)
   */
  addPartitions(partitions: FilePartition[]): number {
    if (!this.currentRun) return 0;

    let touched = 0;

    for (const p of partitions) {
      const existing = this.currentRun.partitions.get(p.file);
      if (!existing) {
        // New file partition - add it
        this.currentRun.partitions.set(p.file, { ...p, status: 'pending' });
        touched++;
        continue;
      }

      // Merge new comments for existing file partitions
      const existingComments = new Set(existing.comments ?? []);
      const incomingComments = p.comments ?? [];
      let hasNew = false;
      for (const c of incomingComments) {
        if (!existingComments.has(c)) {
          existingComments.add(c);
          hasNew = true;
        }
      }

      if (hasNew) {
        // If the partition was already completed, reopen it for new work
        const shouldReopen = existing.status === 'done' || existing.status === 'failed';
        this.currentRun.partitions.set(p.file, {
          ...existing,
          comments: Array.from(existingComments),
          status: shouldReopen ? 'pending' : existing.status,
          claimedBy: shouldReopen ? undefined : existing.claimedBy,
          claimedAt: shouldReopen ? undefined : existing.claimedAt,
          result: shouldReopen ? undefined : existing.result
        });
        touched++;
      }
    }

    // Reopen run if it was completed and we added/updated work
    if (touched > 0 && this.currentRun.completedAt) {
      logger.warning(`[coordination] Reopening completed run ${this.currentRun.runId} - added/updated ${touched} partitions`);
      this.currentRun.completedAt = undefined;
    }

    return touched;
  }

  /**
   * Check if all current partitions are done/failed (for refresh check)
   */
  allPartitionsDone(): boolean {
    if (!this.currentRun) return false;
    return Array.from(this.currentRun.partitions.values()).every(
      p => p.status === 'done' || p.status === 'failed'
    );
  }
}

export const stateManager = new CoordinationStateManager();
