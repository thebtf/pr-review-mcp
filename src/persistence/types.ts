/**
 * Persistence layer types for SQLite-backed invocation and agent status storage.
 */

export interface StoredInvocation {
  id: number;
  owner: string;
  repo: string;
  pr: number;
  sessionId: string;
  agents: string[];       // parsed from JSON column
  since: string;          // ISO 8601
  invokedAt: string;      // ISO 8601
  status: 'active' | 'completed' | 'partial' | 'timed_out' | 'stale';
  completedAt: string | null;
  result: object | null;  // parsed from JSON column
}

export interface StoredAgentStatus {
  id: number;
  invocationId: number;
  agentId: string;
  ready: boolean;
  confidence: string | null;
  source: string | null;
  lastActivity: string | null;
  timedOut: boolean;
  detail: string | null;
  checkedAt: string;      // ISO 8601
}
