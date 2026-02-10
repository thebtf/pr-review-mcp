import { z } from 'zod';
import type { Severity } from '../extractors/severity.js';

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
  confirm: z.literal(true)
});

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
