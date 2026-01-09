import { randomUUID } from 'crypto';
import path from 'path';
import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import type {
  CoordinationState,
  FilePartition,
  AgentState,
  PartitionResult,
  NitpickResolution
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

  /**
   * Initialize a new coordination run
   * Note: This replaces any existing run (completed or not) without explicit cleanup
   */
  initRun(
    prInfo: { owner: string; repo: string; pr: number },
    headSha: string,
    partitions: FilePartition[]
  ): string {
    if (this.currentRun && !this.currentRun.completedAt) {
      console.warn(
        `[coordination] Overwriting active run ${this.currentRun.runId} for ` +
        `${this.currentRun.prInfo.owner}/${this.currentRun.prInfo.repo}#${this.currentRun.prInfo.pr}`
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
      active: true,
      runId: this.currentRun.runId,
      prInfo: this.currentRun.prInfo,
      progress: counts,
      total: this.currentRun.partitions.size,
      agents: agentsList,
      startedAt: this.currentRun.startedAt,
      completedAt: this.currentRun.completedAt
    };
  }

  async markNitpickResolved(nitpickId: string, agentId: string): Promise<void> {
    await this.ensureNitpicksLoaded();
    this.resolvedNitpicks.set(nitpickId, {
      resolvedAt: new Date().toISOString(),
      resolvedBy: agentId
    });
    await this.persistNitpicksAsync();
  }

  async isNitpickResolved(nitpickId: string): Promise<boolean> {
    await this.ensureNitpicksLoaded();
    return this.resolvedNitpicks.has(nitpickId);
  }

  getResolvedNitpicksCount(): number {
    return this.resolvedNitpicks.size;
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

  private getPrKey(): string {
    if (!this.currentRun) return 'unknown';
    const { owner, repo, pr } = this.currentRun.prInfo;
    return `${owner}-${repo}-${pr}`;
  }

  private getNitpicksPath(): string {
    const prKey = this.getPrKey();
    return path.join(process.cwd(), '.agent', 'status', `nitpicks-${prKey}.json`);
  }

  private async ensureNitpicksLoaded(): Promise<void> {
    const prKey = this.getPrKey();
    if (this.nitpicksLoaded && this.currentPrKey === prKey) return;

    const filePath = this.getNitpicksPath();
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

  private async persistNitpicksAsync(): Promise<void> {
    const filePath = this.getNitpicksPath();
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
  }
}

export const stateManager = new CoordinationStateManager();
