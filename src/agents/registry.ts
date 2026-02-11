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
  },
  sourcery: {
    name: 'Sourcery',
    command: '@sourcery-ai review',
    type: 'mention',
    supports: ['focus'],
    authorPattern: ['sourcery-ai', 'sourcery-ai-experiments'],
  },
  qodo: {
    name: 'Qodo',
    command: '/review',
    type: 'slash',
    supports: ['files'],
    msysWorkaround: true,
    authorPattern: 'qodo-code-review[bot]',
  },
  gemini: {
    name: 'Gemini',
    command: '@gemini-code-assist review',
    type: 'mention',
    supports: ['focus'],
    authorPattern: 'gemini-code-assist',
  },
  codex: {
    name: 'Codex',
    command: '@codex review',
    type: 'mention',
    supports: [],
    authorPattern: 'chatgpt-codex-connector',
  },
  copilot: {
    name: 'Copilot',
    command: '@copilot review',
    type: 'mention',
    supports: [],
    authorPattern: 'copilot-pull-request-reviewer',
  },
  greptile: {
    name: 'Greptile',
    command: '@greptile review',
    type: 'mention',
    supports: ['focus'],
    authorPattern: 'greptile',
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
