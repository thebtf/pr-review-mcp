/**
 * Unit tests for agent registry
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  INVOKABLE_AGENTS,
  PARSABLE_SOURCES,
  getDefaultAgents,
  getReviewMode,
  getEnvConfig,
  getAgentConfig,
  getInvokableAgentIds,
  isInvokableAgent,
  type InvokableAgentId,
} from './registry.js';

describe('INVOKABLE_AGENTS', () => {
  it('contains all expected agents', () => {
    const expectedAgents: InvokableAgentId[] = ['coderabbit', 'sourcery', 'qodo', 'gemini', 'codex', 'copilot', 'greptile'];
    for (const agent of expectedAgents) {
      expect(INVOKABLE_AGENTS[agent]).toBeDefined();
    }
  });

  it('has required properties for each agent', () => {
    for (const config of Object.values(INVOKABLE_AGENTS)) {
      expect(config.name).toBeDefined();
      expect(config.command).toBeDefined();
      expect(config.type).toMatch(/^(mention|slash)$/);
      expect(Array.isArray(config.supports)).toBe(true);
      expect(config.authorPattern).toBeDefined();
    }
  });

  it('coderabbit supports focus, files, incremental', () => {
    expect(INVOKABLE_AGENTS.coderabbit.supports).toContain('focus');
    expect(INVOKABLE_AGENTS.coderabbit.supports).toContain('files');
    expect(INVOKABLE_AGENTS.coderabbit.supports).toContain('incremental');
  });

  it('qodo uses slash command with msysWorkaround', () => {
    expect(INVOKABLE_AGENTS.qodo.type).toBe('slash');
    expect(INVOKABLE_AGENTS.qodo.msysWorkaround).toBe(true);
  });
});

describe('PARSABLE_SOURCES', () => {
  it('contains all parsable sources', () => {
    expect(PARSABLE_SOURCES).toContain('coderabbit');
    expect(PARSABLE_SOURCES).toContain('sourcery');
    expect(PARSABLE_SOURCES).toContain('qodo');
    expect(PARSABLE_SOURCES).toContain('gemini');
    expect(PARSABLE_SOURCES).toContain('copilot');
    expect(PARSABLE_SOURCES).toContain('codex');
    expect(PARSABLE_SOURCES).toContain('greptile');
  });
});

describe('getDefaultAgents', () => {
  const originalEnv = process.env.PR_REVIEW_AGENTS;

  beforeEach(() => {
    // No module reset needed - getDefaultAgents reads env at call time
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PR_REVIEW_AGENTS;
    } else {
      process.env.PR_REVIEW_AGENTS = originalEnv;
    }
  });

  it('returns coderabbit by default when env not set', () => {
    delete process.env.PR_REVIEW_AGENTS;
    const agents = getDefaultAgents();
    expect(agents).toEqual(['coderabbit']);
  });

  it('returns coderabbit for empty string', () => {
    process.env.PR_REVIEW_AGENTS = '';
    const agents = getDefaultAgents();
    expect(agents).toEqual(['coderabbit']);
  });

  it('returns coderabbit for whitespace-only', () => {
    process.env.PR_REVIEW_AGENTS = '   ';
    const agents = getDefaultAgents();
    expect(agents).toEqual(['coderabbit']);
  });

  it('parses comma-separated agent IDs', () => {
    process.env.PR_REVIEW_AGENTS = 'coderabbit,gemini,codex';
    const agents = getDefaultAgents();
    expect(agents).toEqual(['coderabbit', 'gemini', 'codex']);
  });

  it('handles whitespace around agent IDs', () => {
    process.env.PR_REVIEW_AGENTS = ' coderabbit , gemini , codex ';
    const agents = getDefaultAgents();
    expect(agents).toEqual(['coderabbit', 'gemini', 'codex']);
  });

  it('is case insensitive', () => {
    process.env.PR_REVIEW_AGENTS = 'CODERABBIT,Gemini,CODEX';
    const agents = getDefaultAgents();
    expect(agents).toEqual(['coderabbit', 'gemini', 'codex']);
  });

  it('filters out invalid agent IDs', () => {
    process.env.PR_REVIEW_AGENTS = 'coderabbit,invalid,gemini';
    const agents = getDefaultAgents();
    expect(agents).toEqual(['coderabbit', 'gemini']);
    expect(agents).not.toContain('invalid');
  });

  it('returns default when all agents invalid', () => {
    process.env.PR_REVIEW_AGENTS = 'invalid1,invalid2';
    const agents = getDefaultAgents();
    expect(agents).toEqual(['coderabbit']);
  });
});

describe('getReviewMode', () => {
  const originalEnv = process.env.PR_REVIEW_MODE;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PR_REVIEW_MODE;
    } else {
      process.env.PR_REVIEW_MODE = originalEnv;
    }
  });

  it('returns sequential by default when env not set', () => {
    delete process.env.PR_REVIEW_MODE;
    expect(getReviewMode()).toBe('sequential');
  });

  it('returns parallel when set to parallel', () => {
    process.env.PR_REVIEW_MODE = 'parallel';
    expect(getReviewMode()).toBe('parallel');
  });

  it('is case insensitive', () => {
    process.env.PR_REVIEW_MODE = 'PARALLEL';
    expect(getReviewMode()).toBe('parallel');
    
    process.env.PR_REVIEW_MODE = 'Parallel';
    expect(getReviewMode()).toBe('parallel');
  });

  it('returns sequential for explicit sequential value', () => {
    process.env.PR_REVIEW_MODE = 'sequential';
    expect(getReviewMode()).toBe('sequential');
  });

  it('returns sequential for invalid values', () => {
    process.env.PR_REVIEW_MODE = 'invalid';
    expect(getReviewMode()).toBe('sequential');
  });
});

describe('getEnvConfig', () => {
  const originalAgents = process.env.PR_REVIEW_AGENTS;
  const originalMode = process.env.PR_REVIEW_MODE;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalAgents === undefined) {
      delete process.env.PR_REVIEW_AGENTS;
    } else {
      process.env.PR_REVIEW_AGENTS = originalAgents;
    }
    if (originalMode === undefined) {
      delete process.env.PR_REVIEW_MODE;
    } else {
      process.env.PR_REVIEW_MODE = originalMode;
    }
  });

  it('returns combined config', () => {
    process.env.PR_REVIEW_AGENTS = 'gemini';
    process.env.PR_REVIEW_MODE = 'parallel';

    const config = getEnvConfig();

    expect(config.agents).toEqual(['gemini']);
    expect(config.mode).toBe('parallel');
  });

  it('returns defaults when env not set', () => {
    delete process.env.PR_REVIEW_AGENTS;
    delete process.env.PR_REVIEW_MODE;

    const config = getEnvConfig();

    expect(config.agents).toEqual(['coderabbit']);
    expect(config.mode).toBe('sequential');
  });
});

describe('getAgentConfig', () => {
  it('returns config for valid agent ID', () => {
    const config = getAgentConfig('coderabbit');
    expect(config).toBeDefined();
    expect(config?.name).toBe('CodeRabbit');
  });

  it('returns undefined for invalid agent ID', () => {
    const config = getAgentConfig('invalid');
    expect(config).toBeUndefined();
  });

  it('returns config for all valid agents', () => {
    const agents: InvokableAgentId[] = ['coderabbit', 'sourcery', 'qodo', 'gemini', 'codex', 'copilot', 'greptile'];
    for (const id of agents) {
      expect(getAgentConfig(id)).toBeDefined();
    }
  });
});

describe('getInvokableAgentIds', () => {
  it('returns all agent IDs', () => {
    const ids = getInvokableAgentIds();
    expect(ids).toContain('coderabbit');
    expect(ids).toContain('sourcery');
    expect(ids).toContain('qodo');
    expect(ids).toContain('gemini');
    expect(ids).toContain('codex');
    expect(ids).toContain('copilot');
    expect(ids).toContain('greptile');
  });

  it('returns array of strings', () => {
    const ids = getInvokableAgentIds();
    expect(Array.isArray(ids)).toBe(true);
    for (const id of ids) {
      expect(typeof id).toBe('string');
    }
  });
});

describe('isInvokableAgent', () => {
  it('returns true for valid agent IDs', () => {
    expect(isInvokableAgent('coderabbit')).toBe(true);
    expect(isInvokableAgent('sourcery')).toBe(true);
    expect(isInvokableAgent('qodo')).toBe(true);
    expect(isInvokableAgent('gemini')).toBe(true);
    expect(isInvokableAgent('codex')).toBe(true);
    expect(isInvokableAgent('copilot')).toBe(true);
    expect(isInvokableAgent('greptile')).toBe(true);
  });

  it('returns false for invalid agent IDs', () => {
    expect(isInvokableAgent('invalid')).toBe(false);
    expect(isInvokableAgent('')).toBe(false);
    expect(isInvokableAgent('CODERABBIT')).toBe(false); // Case sensitive
    expect(isInvokableAgent('toString')).toBe(false); // Prototype method
    expect(isInvokableAgent('__proto__')).toBe(false); // Prototype pollution attempt
  });
});
