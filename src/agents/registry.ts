/**
 * Agent Registry - Defines invokable AI code review agents
 *
 * Configuration via environment variables:
 * - PR_REVIEW_AGENTS: Comma-separated list of agents to invoke (default: 'coderabbit')
 * - PR_REVIEW_MODE: 'sequential' | 'parallel' (default: 'sequential')
 */

import { logger } from '../logging.js';

// ============================================================================
// Types
// ============================================================================

/** Source types for completion detection */
export type CompletionSource = 'reviews' | 'issue_comments' | 'check_runs';

/** Per-agent strategy for detecting review completion */
export interface CompletionStrategy {
  /** Primary signal sources to check (in priority order) */
  sources: CompletionSource[];
  /** Body pattern that confirms completion (regex) */
  bodyPattern?: RegExp;
  /** Patterns that indicate NOT complete (placeholders, errors, rate limits) */
  excludePatterns?: RegExp[];
  /** Whether to filter reviews by state !== PENDING */
  filterPendingReviews: boolean;
  /** Expected completion time in ms (for logging/monitoring) */
  expectedTimeMs: number;
  /** Max time before declaring agent "likely not responding" */
  maxWaitMs: number;
  /** GitHub App slugs for check run detection */
  checkRunAppSlugs?: string[];
}

export interface AgentConfig {
  /** Human-readable agent name */
  name: string;
  /** Command to invoke the agent (mention or slash command) */
  command: string;
  /** Type of invocation: @mention or /slash command */
  type: 'mention' | 'slash';
  /** Supported options: focus, files, incremental */
  supports: ('focus' | 'files' | 'incremental')[];
  /** Whether to apply MSYS_NO_PATHCONV workaround on Windows */
  msysWorkaround?: boolean;
  /** Author login pattern for detection */
  authorPattern: string | string[];
  /** How to detect that this agent has completed its review */
  completionStrategy: CompletionStrategy;
}

export type InvokableAgentId = 'coderabbit' | 'sourcery' | 'qodo' | 'gemini' | 'codex' | 'copilot' | 'greptile';
export type ReviewMode = 'sequential' | 'parallel';

// ============================================================================
// Agent Definitions
// ============================================================================

/**
 * Agents that can be manually invoked via pr_invoke
 */
export const INVOKABLE_AGENTS: Record<InvokableAgentId, AgentConfig> = {
  coderabbit: {
    name: 'CodeRabbit',
    command: '@coderabbitai review',
    type: 'mention',
    supports: ['focus', 'files', 'incremental'],
    authorPattern: 'coderabbitai',
    completionStrategy: {
      sources: ['check_runs', 'reviews'],
      bodyPattern: /^\*\*Actionable comments posted: \d+\*\*/,
      filterPendingReviews: true,
      expectedTimeMs: 300_000,   // 5 min
      maxWaitMs: 720_000,        // 12 min
      checkRunAppSlugs: ['coderabbitai', 'coderabbit'],
    },
  },
  sourcery: {
    name: 'Sourcery',
    command: '@sourcery-ai review',
    type: 'mention',
    supports: ['focus'],
    authorPattern: ['sourcery-ai', 'sourcery-ai-experiments'],
    completionStrategy: {
      sources: ['reviews'],
      bodyPattern: /^Hey - I've found \d+ issues?/,
      excludePatterns: [/rate limit/i, /review limit/i],
      filterPendingReviews: true,
      expectedTimeMs: 120_000,   // 2 min
      maxWaitMs: 300_000,        // 5 min
      checkRunAppSlugs: ['sourcery-ai', 'sourcery'],
    },
  },
  qodo: {
    name: 'Qodo',
    command: '/review',
    type: 'slash',
    supports: ['files'],
    msysWorkaround: true,
    authorPattern: ['qodo-code-review', 'qodo-code-review[bot]'],
    completionStrategy: {
      sources: ['issue_comments'],
      bodyPattern: /(?:<h3>Code Review by Qodo<\/h3>|## PR Reviewer Guide)/,
      filterPendingReviews: false,
      expectedTimeMs: 360_000,   // 6 min
      maxWaitMs: 600_000,        // 10 min
    },
  },
  gemini: {
    name: 'Gemini',
    command: '@gemini-code-assist review',
    type: 'mention',
    supports: ['focus'],
    authorPattern: 'gemini-code-assist',
    completionStrategy: {
      sources: ['reviews'],
      bodyPattern: /^## Code Review\n/,
      excludePatterns: [/I'm currently reviewing/i, /will post my feedback shortly/i],
      filterPendingReviews: true,
      expectedTimeMs: 240_000,   // 4 min
      maxWaitMs: 600_000,        // 10 min
      checkRunAppSlugs: ['gemini-code-assist'],
    },
  },
  codex: {
    name: 'Codex',
    command: '@codex review',
    type: 'mention',
    supports: [],
    authorPattern: 'chatgpt-codex-connector',
    completionStrategy: {
      sources: ['reviews'],
      bodyPattern: /^### 💡 Codex Review/,
      excludePatterns: [/create a Codex account/i, /create an environment/i],
      filterPendingReviews: true,
      expectedTimeMs: 300_000,   // 5 min
      maxWaitMs: 600_000,        // 10 min
    },
  },
  copilot: {
    name: 'Copilot',
    command: '@copilot review',
    type: 'mention',
    supports: [],
    authorPattern: 'copilot-pull-request-reviewer',
    completionStrategy: {
      sources: ['reviews'],
      bodyPattern: /^## Pull request overview\n/,
      filterPendingReviews: true,
      expectedTimeMs: 30_000,    // 30 sec
      maxWaitMs: 1_800_000,      // 30 min (can be slow)
    },
  },
  greptile: {
    name: 'Greptile',
    command: '@greptile review',
    type: 'mention',
    supports: ['focus'],
    authorPattern: 'greptile-apps',
    completionStrategy: {
      sources: ['reviews', 'issue_comments'],
      bodyPattern: /(?:<sub>\d+ files reviewed|<h2>Greptile Overview<\/h2>)/,
      excludePatterns: [/free trial has ended/i],
      filterPendingReviews: true,
      expectedTimeMs: 300_000,   // 5 min
      maxWaitMs: 600_000,        // 10 min
      checkRunAppSlugs: ['greptile'],
    },
  },
};

/**
 * All agents whose comments can be parsed (includes automatic agents)
 */
export const PARSABLE_SOURCES = [
  'coderabbit',
  'sourcery',
  'qodo',
  'gemini',
  'copilot',
  'codex',
  'greptile',
] as const;

export type ParsableSource = typeof PARSABLE_SOURCES[number];

// ============================================================================
// Environment Configuration
// ============================================================================

const DEFAULT_AGENTS: InvokableAgentId[] = ['coderabbit'];
const DEFAULT_MODE: ReviewMode = 'sequential';

/**
 * Get default agents from PR_REVIEW_AGENTS environment variable
 * Format: comma-separated list of agent IDs (e.g., "coderabbit,gemini,codex")
 * Default: ['coderabbit']
 */
export function getDefaultAgents(): InvokableAgentId[] {
  const envValue = process.env.PR_REVIEW_AGENTS;

  if (!envValue || envValue.trim() === '') {
    return DEFAULT_AGENTS;
  }

  const rawAgents = envValue
    .split(',')
    .map(s => s.trim().toLowerCase());

  const invalidAgents = rawAgents.filter(id => !isInvokableAgent(id));
  if (invalidAgents.length > 0) {
    logger.warning(`[registry] Invalid agent IDs in PR_REVIEW_AGENTS: ${invalidAgents.join(', ')}`);
  }

  const agents = rawAgents.filter((id): id is InvokableAgentId => isInvokableAgent(id));

  return agents.length > 0 ? agents : DEFAULT_AGENTS;
}

/**
 * Get review mode from PR_REVIEW_MODE environment variable
 * Values: 'sequential' | 'parallel'
 * Default: 'sequential'
 */
export function getReviewMode(): ReviewMode {
  const envValue = process.env.PR_REVIEW_MODE?.toLowerCase();

  if (envValue === 'parallel') {
    return 'parallel';
  }

  if (envValue && envValue !== 'sequential') {
    logger.warning(`[registry] Invalid PR_REVIEW_MODE: "${envValue}", using default: sequential`);
  }

  return DEFAULT_MODE;
}

/**
 * Get full environment configuration
 */
export function getEnvConfig(): { agents: InvokableAgentId[]; mode: ReviewMode } {
  return {
    agents: getDefaultAgents(),
    mode: getReviewMode()
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get agent config by ID
 */
export function getAgentConfig(agentId: string): AgentConfig | undefined {
  return INVOKABLE_AGENTS[agentId as InvokableAgentId];
}

/**
 * Get all invokable agent IDs
 */
export function getInvokableAgentIds(): InvokableAgentId[] {
  return Object.keys(INVOKABLE_AGENTS) as InvokableAgentId[];
}

/**
 * Check if an agent ID is valid and invokable
 * Uses Object.hasOwn to avoid prototype chain issues
 */
export function isInvokableAgent(agentId: string): agentId is InvokableAgentId {
  return Object.hasOwn(INVOKABLE_AGENTS, agentId);
}
