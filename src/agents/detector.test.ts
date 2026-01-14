/**
 * Unit tests for agent detection
 */

import { describe, it, expect } from 'vitest';
import { matchesAuthorPattern, getAgentFromAuthor } from './detector.js';

describe('matchesAuthorPattern', () => {
  describe('single pattern', () => {
    it('matches exact pattern', () => {
      expect(matchesAuthorPattern('coderabbitai', 'coderabbitai')).toBe(true);
    });

    it('matches pattern with [bot] suffix', () => {
      expect(matchesAuthorPattern('coderabbitai[bot]', 'coderabbitai')).toBe(true);
    });

    it('matches pattern prefix', () => {
      expect(matchesAuthorPattern('coderabbitai-something', 'coderabbitai')).toBe(true);
    });

    it('is case insensitive', () => {
      expect(matchesAuthorPattern('CodeRabbitAI', 'coderabbitai')).toBe(true);
      expect(matchesAuthorPattern('coderabbitai', 'CodeRabbitAI')).toBe(true);
    });

    it('does not match unrelated logins', () => {
      expect(matchesAuthorPattern('other-bot', 'coderabbitai')).toBe(false);
    });
  });

  describe('array of patterns', () => {
    const patterns = ['sourcery-ai', 'sourcery-ai-experiments'];

    it('matches any pattern in array', () => {
      expect(matchesAuthorPattern('sourcery-ai[bot]', patterns)).toBe(true);
      expect(matchesAuthorPattern('sourcery-ai-experiments[bot]', patterns)).toBe(true);
    });

    it('does not match if no pattern matches', () => {
      expect(matchesAuthorPattern('other-ai', patterns)).toBe(false);
    });
  });
});

describe('getAgentFromAuthor', () => {
  it('identifies CodeRabbit', () => {
    expect(getAgentFromAuthor('coderabbitai[bot]')).toBe('coderabbit');
    expect(getAgentFromAuthor('coderabbitai')).toBe('coderabbit');
  });

  it('identifies Sourcery', () => {
    expect(getAgentFromAuthor('sourcery-ai[bot]')).toBe('sourcery');
    expect(getAgentFromAuthor('sourcery-ai-experiments[bot]')).toBe('sourcery');
  });

  it('identifies Qodo', () => {
    expect(getAgentFromAuthor('qodo-code-review[bot]')).toBe('qodo');
  });

  it('identifies Gemini', () => {
    expect(getAgentFromAuthor('gemini-code-assist[bot]')).toBe('gemini');
  });

  it('identifies Codex', () => {
    expect(getAgentFromAuthor('chatgpt-codex-connector[bot]')).toBe('codex');
  });

  it('identifies Copilot', () => {
    expect(getAgentFromAuthor('copilot-pull-request-reviewer[bot]')).toBe('copilot');
  });

  it('returns null for unknown authors', () => {
    expect(getAgentFromAuthor('some-random-user')).toBe(null);
    expect(getAgentFromAuthor('dependabot[bot]')).toBe(null);
  });
});

/**
 * Integration tests for detectReviewedAgents require complex mocking
 * Use scripts/test-detector.mjs for real PR testing
 * 
 * The pure function tests above (matchesAuthorPattern, getAgentFromAuthor)
 * cover the core logic without external dependencies
 */
