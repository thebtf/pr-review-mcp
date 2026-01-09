import { randomUUID } from 'crypto';
import type { 
  CoordinationState, 
  FilePartition, 
  AgentState, 
  PartitionResult 
} from './types.js';

class CoordinationStateManager {
  private currentRun: CoordinationState | null = null;
  private readonly STALE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

  /**
   * Initialize a new coordination run
   */
  initRun(
    prInfo: { owner: string; repo: string; pr: number },
    headSha: string,
    partitions: FilePartition[]
  ): string {
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
      failed: 0
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

  /**
   * Re-queue partitions from stale agents
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
        agent.claimedFiles = [];
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

  public getCurrentRun() {
    return this.currentRun;
  }
}

export const stateManager = new CoordinationStateManager();
