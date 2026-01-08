/**
 * Agent Registry - Defines invokable AI code review agents
 */

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

export type InvokableAgentId = 'coderabbit' | 'sourcery' | 'qodo';

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
] as const;

export type ParsableSource = typeof PARSABLE_SOURCES[number];

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
 */
export function isInvokableAgent(agentId: string): agentId is InvokableAgentId {
  return agentId in INVOKABLE_AGENTS;
}
