import { z } from 'zod';
import type { Severity } from '../extractors/severity.js';

// ---------------------------------------------------------------------------
// Shared interface implemented by both CoordinationStateManager and
// SqliteCoordinationStateManager. All tools and callers depend on this
// interface, not on either concrete class.
// ---------------------------------------------------------------------------
export interface ICoordinationStateManager {
  clearExpiredRuns(maxAgeMs?: number): boolean;
  initRun(
    prInfo: { owner: string; repo: string; pr: number },
    headSha: string,
    partitions: FilePartition[],
  ): string;
  claimPartition(agentId: string): FilePartition | null;
  reportProgress(
    agentId: string,
    file: string,
    status: 'done' | 'failed' | 'skipped',
    result?: PartitionResult,
  ): boolean;
  getStatus(): CoordinationStatus;
  markNitpickResolved(
    nitpickId: string,
    agentId: string,
    prInfo?: { owner: string; repo: string; pr: number },
  ): Promise<void>;
  isNitpickResolved(
    nitpickId: string,
    prInfo?: { owner: string; repo: string; pr: number },
  ): Promise<boolean>;
  getResolvedNitpicksCount(prInfo?: { owner: string; repo: string; pr: number }): Promise<number>;
  updateOrchestratorPhase(phase: OrchestratorPhaseType, detail?: string): void;
  getOrchestratorProgress(): OrchestratorProgress | null;
  registerParentChild(
    parentId: string,
    childIds: string[],
    prInfo: { owner: string; repo: string; pr: number },
  ): Promise<void>;
  markChildResolved(
    childId: string,
    prInfo: { owner: string; repo: string; pr: number },
  ): Promise<void>;
  isChildResolved(
    childId: string,
    prInfo: { owner: string; repo: string; pr: number },
  ): Promise<boolean>;
  areAllChildrenResolved(
    parentId: string,
    prInfo: { owner: string; repo: string; pr: number },
  ): Promise<boolean>;
  getParentIdForChild(
    childId: string,
    prInfo: { owner: string; repo: string; pr: number },
  ): Promise<string | null>;
  cleanupStaleAgents(timeoutMs?: number): void;
  getCurrentRun(): CoordinationState | null;
  isRunActive(): boolean;
  getRunAge(): number | null;
  forceComplete(): boolean;
  resetRun(): void;
  addPartitions(partitions: FilePartition[]): number;
  allPartitionsDone(): boolean;
}

// Zod schemas for tool inputs
export const ClaimWorkSchema = z.object({
  agent_id: z.string().min(1),
  run_id: z.string().optional(),
  pr_info: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    pr: z.number().int().positive()
  }).optional(),
  force: z.boolean().optional()
});

export const ReportProgressSchema = z.object({
  agent_id: z.string().min(1),
  file: z.string().min(1),
  status: z.enum(['done', 'failed', 'skipped']),
  result: z.object({
    commentsProcessed: z.number(),
    commentsResolved: z.number(),
    errors: z.array(z.string()).optional()
  }).optional()
});

export const GetWorkStatusSchema = z.object({
  run_id: z.string().optional()
});

export const ResetCoordinationSchema = z.object({
  confirm: z.boolean().optional().describe(
    'Safety guard: set true to confirm reset. If omitted, server will try interactive elicitation.'
  ),
});

// Return type for getStatus()
export interface CoordinationStatus {
  active: boolean;
  runId?: string;
  prInfo?: { owner: string; repo: string; pr: number };
  progress?: { pending: number; claimed: number; done: number; failed: number; skipped: number };
  total?: number;
  agents?: { agentId: string; claimedCount: number; completedCount: number; lastSeen: string }[];
  startedAt?: string;
  completedAt?: string;
}

// TypeScript interfaces
export interface FilePartition {
  file: string;
  comments: string[];
  severity: Severity;
  status: 'pending' | 'claimed' | 'done' | 'failed' | 'skipped';
  claimedBy?: string;
  claimedAt?: string;
  result?: PartitionResult;
}

export interface PartitionResult {
  commentsProcessed: number;
  commentsResolved: number;
  errors?: string[];
}

export interface NitpickResolution {
  resolvedAt: string;
  resolvedBy: string;
}

export interface ParentChildEntry {
  childIds: string[];
  childStatus: Record<string, 'pending' | 'resolved'>;
  registeredAt: string;
}

export type ParentChildMap = Record<string, ParentChildEntry>;

export interface AgentState {
  agentId: string;
  claimedFiles: string[];
  completedFiles: string[];
  lastSeen: string;
}

export interface CoordinationState {
  runId: string;
  prInfo: { owner: string; repo: string; pr: number };
  headSha: string;
  partitions: Map<string, FilePartition>;
  agents: Map<string, AgentState>;
  startedAt: string;
  completedAt?: string;
}

// Orchestrator progress tracking (Phase 4: Progress Bus)
export const OrchestratorPhase = z.enum([
  'escape_check', 'preflight', 'label', 'invoke_agents', 'poll_wait',
  'spawn_workers', 'monitor', 'build_test', 'complete', 'error', 'aborted'
]);
export type OrchestratorPhaseType = z.infer<typeof OrchestratorPhase>;

export interface PhaseEntry {
  phase: OrchestratorPhaseType;
  detail?: string;
  timestamp: string;
}

export interface OrchestratorProgress {
  currentPhase: OrchestratorPhaseType;
  detail?: string;
  history: PhaseEntry[];
  startedAt: string;
  completedAt?: string;
}

export const ProgressUpdateSchema = z.object({
  phase: OrchestratorPhase,
  detail: z.string().max(200).optional()
});

export const ProgressCheckSchema = z.object({});

export type ClaimWorkInput = z.infer<typeof ClaimWorkSchema>;
export type ReportProgressInput = z.infer<typeof ReportProgressSchema>;
export type GetWorkStatusInput = z.infer<typeof GetWorkStatusSchema>;
export type ResetCoordinationInput = z.infer<typeof ResetCoordinationSchema>;
export type ProgressUpdateInput = z.infer<typeof ProgressUpdateSchema>;
export type ProgressCheckInput = z.infer<typeof ProgressCheckSchema>;
