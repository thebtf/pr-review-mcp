/**
 * Unit tests for agent invoker (pure functions only)
 */

import { describe, it, expect } from 'vitest';
import { buildCommand, aggregateResults, type InvokeResult } from './invoker.js';
import { INVOKABLE_AGENTS, type AgentConfig } from './registry.js';

describe('buildCommand', () => {
  describe('basic command building', () => {
    it('returns base command without options', () => {
      const config = INVOKABLE_AGENTS.coderabbit;
      const command = buildCommand(config);
      expect(command).toBe('@coderabbitai review');
    });

    it('returns base command with undefined options', () => {
      const config = INVOKABLE_AGENTS.coderabbit;
      const command = buildCommand(config, undefined);
      expect(command).toBe('@coderabbitai review');
    });

    it('returns base command with empty options', () => {
      const config = INVOKABLE_AGENTS.coderabbit;
      const command = buildCommand(config, {});
      expect(command).toBe('@coderabbitai review');
    });
  });

  describe('focus option', () => {
    it('adds focus option when supported', () => {
      const config = INVOKABLE_AGENTS.coderabbit; // supports focus
      const command = buildCommand(config, { focus: 'security' });
      expect(command).toBe('@coderabbitai review focus:security');
    });

    it('ignores focus option when not supported', () => {
      const config = INVOKABLE_AGENTS.codex; // does not support focus
      const command = buildCommand(config, { focus: 'security' });
      expect(command).toBe('@codex review');
    });
  });

  describe('files option', () => {
    it('adds files option when supported', () => {
      const config = INVOKABLE_AGENTS.coderabbit; // supports files
      const command = buildCommand(config, { files: ['src/main.ts', 'src/utils.ts'] });
      expect(command).toBe('@coderabbitai review files:src/main.ts,src/utils.ts');
    });

    it('handles single file', () => {
      const config = INVOKABLE_AGENTS.coderabbit;
      const command = buildCommand(config, { files: ['src/main.ts'] });
      expect(command).toBe('@coderabbitai review files:src/main.ts');
    });

    it('ignores files option when not supported', () => {
      const config = INVOKABLE_AGENTS.gemini; // does not support files
      const command = buildCommand(config, { files: ['src/main.ts'] });
      expect(command).toBe('@gemini-code-assist review');
    });

    it('ignores empty files array', () => {
      const config = INVOKABLE_AGENTS.coderabbit;
      const command = buildCommand(config, { files: [] });
      expect(command).toBe('@coderabbitai review');
    });
  });

  describe('incremental option', () => {
    it('adds incremental option when supported', () => {
      const config = INVOKABLE_AGENTS.coderabbit; // supports incremental
      const command = buildCommand(config, { incremental: true });
      expect(command).toBe('@coderabbitai review incremental');
    });

    it('ignores incremental when false', () => {
      const config = INVOKABLE_AGENTS.coderabbit;
      const command = buildCommand(config, { incremental: false });
      expect(command).toBe('@coderabbitai review');
    });

    it('ignores incremental option when not supported', () => {
      const config = INVOKABLE_AGENTS.gemini; // does not support incremental
      const command = buildCommand(config, { incremental: true });
      expect(command).toBe('@gemini-code-assist review');
    });
  });

  describe('multiple options', () => {
    it('combines multiple options', () => {
      const config = INVOKABLE_AGENTS.coderabbit;
      const command = buildCommand(config, {
        focus: 'security',
        files: ['src/auth.ts'],
        incremental: true
      });
      expect(command).toBe('@coderabbitai review focus:security files:src/auth.ts incremental');
    });

    it('only includes supported options', () => {
      const config = INVOKABLE_AGENTS.gemini; // supports only focus
      const command = buildCommand(config, {
        focus: 'performance',
        files: ['src/main.ts'],
        incremental: true
      });
      expect(command).toBe('@gemini-code-assist review focus:performance');
    });
  });

  describe('force option', () => {
    it('force option does not affect command', () => {
      // force is handled by invoke logic, not command building
      const config = INVOKABLE_AGENTS.coderabbit;
      const command = buildCommand(config, { force: true });
      expect(command).toBe('@coderabbitai review');
    });
  });

  describe('slash command agents', () => {
    it('builds qodo slash command correctly', () => {
      const config = INVOKABLE_AGENTS.qodo;
      const command = buildCommand(config);
      expect(command).toBe('/review');
    });

    it('adds files option to qodo command', () => {
      const config = INVOKABLE_AGENTS.qodo; // supports files
      const command = buildCommand(config, { files: ['src/main.ts'] });
      expect(command).toBe('/review files:src/main.ts');
    });
  });
});

describe('aggregateResults', () => {
  const createResult = (agent: string, success: boolean): InvokeResult => ({
    success,
    agent,
    agentName: agent.charAt(0).toUpperCase() + agent.slice(1),
    commentUrl: success ? `https://github.com/test/repo/pull/1#comment-${agent}` : null,
    message: success ? `${agent} invoked successfully` : `${agent} failed`
  });

  describe('success status', () => {
    it('returns success true when all succeed', () => {
      const results = [
        createResult('coderabbit', true),
        createResult('gemini', true)
      ];
      const aggregated = aggregateResults(results);
      expect(aggregated.success).toBe(true);
    });

    it('returns success false when any fails', () => {
      const results = [
        createResult('coderabbit', true),
        createResult('gemini', false)
      ];
      const aggregated = aggregateResults(results);
      expect(aggregated.success).toBe(false);
    });

    it('returns success true for empty results', () => {
      const aggregated = aggregateResults([]);
      expect(aggregated.success).toBe(true);
    });
  });

  describe('invoked and failed lists', () => {
    it('separates invoked and failed agents', () => {
      const results = [
        createResult('coderabbit', true),
        createResult('gemini', false),
        createResult('codex', true)
      ];
      const aggregated = aggregateResults(results);

      expect(aggregated.invoked).toEqual(['Coderabbit', 'Codex']);
      expect(aggregated.failed).toEqual(['Gemini']);
    });

    it('handles all successful', () => {
      const results = [
        createResult('coderabbit', true),
        createResult('gemini', true)
      ];
      const aggregated = aggregateResults(results);

      expect(aggregated.invoked).toEqual(['Coderabbit', 'Gemini']);
      expect(aggregated.failed).toEqual([]);
    });

    it('handles all failed', () => {
      const results = [
        createResult('coderabbit', false),
        createResult('gemini', false)
      ];
      const aggregated = aggregateResults(results);

      expect(aggregated.invoked).toEqual([]);
      expect(aggregated.failed).toEqual(['Coderabbit', 'Gemini']);
    });
  });

  describe('skipped agents', () => {
    it('includes skipped agents in result', () => {
      const results = [createResult('coderabbit', true)];
      const skipped = ['Gemini', 'Codex'];
      const aggregated = aggregateResults(results, skipped);

      expect(aggregated.skipped).toEqual(['Gemini', 'Codex']);
    });

    it('defaults to empty skipped array', () => {
      const results = [createResult('coderabbit', true)];
      const aggregated = aggregateResults(results);

      expect(aggregated.skipped).toEqual([]);
    });
  });

  describe('message generation', () => {
    it('generates invoked message', () => {
      const results = [createResult('coderabbit', true)];
      const aggregated = aggregateResults(results);

      expect(aggregated.message).toBe('Invoked: Coderabbit');
    });

    it('generates failed message', () => {
      const results = [createResult('gemini', false)];
      const aggregated = aggregateResults(results);

      expect(aggregated.message).toBe('Failed: Gemini');
    });

    it('generates skipped message', () => {
      const aggregated = aggregateResults([], ['Gemini', 'Codex']);

      expect(aggregated.message).toBe('Skipped (already reviewed): Gemini, Codex');
    });

    it('combines all parts in message', () => {
      const results = [
        createResult('coderabbit', true),
        createResult('qodo', false)
      ];
      const skipped = ['Gemini'];
      const aggregated = aggregateResults(results, skipped);

      expect(aggregated.message).toBe(
        'Invoked: Coderabbit. Failed: Qodo. Skipped (already reviewed): Gemini'
      );
    });

    it('generates empty message for no agents', () => {
      const aggregated = aggregateResults([]);
      expect(aggregated.message).toBe('No agents processed');
    });
  });

  describe('results passthrough', () => {
    it('includes original results in output', () => {
      const results = [
        createResult('coderabbit', true),
        createResult('gemini', true)
      ];
      const aggregated = aggregateResults(results);

      expect(aggregated.results).toBe(results);
      expect(aggregated.results.length).toBe(2);
    });
  });
});
