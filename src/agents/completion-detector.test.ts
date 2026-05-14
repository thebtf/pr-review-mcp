/**
 * Unit tests for fetchCompletionStatus in completion-detector.ts
 *
 * Validates registry changes:
 *   - Codex sources now include 'issue_comments' in addition to 'reviews'
 *   - Codex bodyPattern accepts both '### 💡 Codex Review' and 'Codex Review:' prefixes
 *   - Rate-limit bodies are excluded for Codex, Gemini, Copilot, Greptile, Qodo
 */

import { describe, it, expect } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { fetchCompletionStatus } from './completion-detector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* asyncPage<T>(items: T[]) {
  yield { data: items };
}

/**
 * Build a minimal Octokit mock that serves reviews and issue comments.
 * Dispatches based on whether `params` contains `issue_number` (comments)
 * or `pull_number` (reviews).
 */
function makeMockOctokit(
  reviews: object[],
  issueComments: object[],
): Octokit {
  return {
    paginate: {
      iterator: (_fn: unknown, params: Record<string, unknown>) => {
        if ('issue_number' in params) {
          return asyncPage(issueComments);
        }
        return asyncPage(reviews);
      },
    },
    pulls: { listReviews: {} },
    issues: { listComments: {} },
    checks: { listForRef: {} },
    repos: { getCommit: {} },
  } as unknown as Octokit;
}

const SINCE = '2024-01-01T00:00:00Z';
const AFTER_SINCE = '2024-06-01T12:00:00Z';

// ---------------------------------------------------------------------------
// Codex issue-comment completion
// ---------------------------------------------------------------------------

describe('fetchCompletionStatus — Codex issue-comment source', () => {
  it('detects completion via issue comment with "Codex Review:" prefix', async () => {
    const comment = {
      user: { login: 'chatgpt-codex-connector' },
      body: "Codex Review: Didn't find any major issues. More of your lovely PRs please.",
      created_at: AFTER_SINCE,
    };

    const octokit = makeMockOctokit([], [comment]);
    const result = await fetchCompletionStatus(
      'owner', 'repo', 1, ['codex'], SINCE, octokit,
    );

    const codex = result.agents.find(a => a.agentId === 'codex');
    expect(codex?.ready).toBe(true);
    expect(codex?.source).toBe('issue_comments');
  });

  it('ignores issue comment posted before the since timestamp', async () => {
    const comment = {
      user: { login: 'chatgpt-codex-connector' },
      body: 'Codex Review: All good.',
      created_at: '2023-12-31T23:59:59Z', // before SINCE
    };

    const octokit = makeMockOctokit([], [comment]);
    const result = await fetchCompletionStatus(
      'owner', 'repo', 1, ['codex'], SINCE, octokit,
    );

    const codex = result.agents.find(a => a.agentId === 'codex');
    expect(codex?.ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Codex formal PR review completion
// ---------------------------------------------------------------------------

describe('fetchCompletionStatus — Codex PR review source', () => {
  it('detects completion via formal PR review with "### 💡 Codex Review" header', async () => {
    const review = {
      user: { login: 'chatgpt-codex-connector' },
      body: '### 💡 Codex Review\n\nAnalysis complete. No blocking issues found.',
      state: 'COMMENTED',
      submitted_at: AFTER_SINCE,
    };

    const octokit = makeMockOctokit([review], []);
    const result = await fetchCompletionStatus(
      'owner', 'repo', 1, ['codex'], SINCE, octokit,
    );

    const codex = result.agents.find(a => a.agentId === 'codex');
    expect(codex?.ready).toBe(true);
    expect(codex?.source).toBe('reviews');
  });

  it('does not count PENDING reviews for codex', async () => {
    const review = {
      user: { login: 'chatgpt-codex-connector' },
      body: '### 💡 Codex Review\n\nAnalysis complete.',
      state: 'PENDING',
      submitted_at: AFTER_SINCE,
    };

    const octokit = makeMockOctokit([review], []);
    const result = await fetchCompletionStatus(
      'owner', 'repo', 1, ['codex'], SINCE, octokit,
    );

    const codex = result.agents.find(a => a.agentId === 'codex');
    expect(codex?.ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rate-limit exclusion
// ---------------------------------------------------------------------------

describe('fetchCompletionStatus — rate-limit exclusion', () => {
  it('does NOT mark codex ready when review body contains "rate limit"', async () => {
    const review = {
      user: { login: 'chatgpt-codex-connector' },
      body: '### 💡 Codex Review\n\nAPI rate limit exceeded. Please try again later.',
      state: 'COMMENTED',
      submitted_at: AFTER_SINCE,
    };

    const octokit = makeMockOctokit([review], []);
    const result = await fetchCompletionStatus(
      'owner', 'repo', 1, ['codex'], SINCE, octokit,
    );

    const codex = result.agents.find(a => a.agentId === 'codex');
    expect(codex?.ready).toBe(false);
  });

  it('does NOT mark codex ready when issue comment body contains "API rate"', async () => {
    const comment = {
      user: { login: 'chatgpt-codex-connector' },
      body: 'Codex Review: API rate limit exceeded. Please retry.',
      created_at: AFTER_SINCE,
    };

    const octokit = makeMockOctokit([], [comment]);
    const result = await fetchCompletionStatus(
      'owner', 'repo', 1, ['codex'], SINCE, octokit,
    );

    const codex = result.agents.find(a => a.agentId === 'codex');
    expect(codex?.ready).toBe(false);
  });

  it('does NOT mark gemini ready when body contains "quota exceeded"', async () => {
    const review = {
      user: { login: 'gemini-code-assist' },
      body: '## Code Review\n\nQuota exceeded. Try again later.',
      state: 'COMMENTED',
      submitted_at: AFTER_SINCE,
    };

    const octokit = makeMockOctokit([review], []);
    const result = await fetchCompletionStatus(
      'owner', 'repo', 1, ['gemini'], SINCE, octokit,
    );

    const gemini = result.agents.find(a => a.agentId === 'gemini');
    expect(gemini?.ready).toBe(false);
  });

  it('does NOT mark gemini ready when body contains "rate limit"', async () => {
    const review = {
      user: { login: 'gemini-code-assist' },
      body: '## Code Review\n\nRate limit hit. Please wait before requesting again.',
      state: 'COMMENTED',
      submitted_at: AFTER_SINCE,
    };

    const octokit = makeMockOctokit([review], []);
    const result = await fetchCompletionStatus(
      'owner', 'repo', 1, ['gemini'], SINCE, octokit,
    );

    const gemini = result.agents.find(a => a.agentId === 'gemini');
    expect(gemini?.ready).toBe(false);
  });

  it('marks gemini ready when body matches pattern and has no exclude match', async () => {
    const review = {
      user: { login: 'gemini-code-assist' },
      body: '## Code Review\n\nLooks good overall. A few minor suggestions below.',
      state: 'COMMENTED',
      submitted_at: AFTER_SINCE,
    };

    const octokit = makeMockOctokit([review], []);
    const result = await fetchCompletionStatus(
      'owner', 'repo', 1, ['gemini'], SINCE, octokit,
    );

    const gemini = result.agents.find(a => a.agentId === 'gemini');
    expect(gemini?.ready).toBe(true);
  });
});
