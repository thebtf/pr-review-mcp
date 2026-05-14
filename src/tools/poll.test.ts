/**
 * Unit tests for pr_poll_updates — T012 (waitState in poll agent entries).
 */

import { describe, it, expect, vi } from 'vitest';
import { prPollUpdates } from './poll.js';
import type { GitHubClient } from '../github/client.js';

// ============================================================================
// Mock GitHubClient
// ============================================================================

function makeMockClient(): GitHubClient {
  // graphql is called for both listThreads and listReviews; return a shape that
  // satisfies both queries with empty result sets.
  return {
    graphql: vi.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
            totalCount: 0,
          },
          reviews: {
            nodes: [],
          },
        },
      },
    }),
  } as unknown as GitHubClient;
}

// ============================================================================
// Mock Octokit for agent status fetch
// ============================================================================

function makeMockOctokit(overrides: { commits?: unknown[]; prData?: object } = {}) {
  const paginateFn = vi.fn().mockImplementation(async (_method: unknown, _opts: unknown) => {
    return overrides.commits ?? [];
  }) as unknown as import('@octokit/rest').Octokit['paginate'];
  (paginateFn as unknown as { iterator: ReturnType<typeof vi.fn> }).iterator = vi.fn().mockImplementation(
    async function* () { /* no pages */ },
  );

  return {
    pulls: {
      get: vi.fn().mockResolvedValue({
        data: {
          merged: false,
          state: 'open',
          head: { sha: 'abc123' },
          ...(overrides.prData ?? {}),
        },
      }),
      listCommits: vi.fn(),
    },
    issues: {
      listComments: vi.fn(),
    },
    repos: {
      getCombinedStatusForRef: vi.fn().mockResolvedValue({
        data: { state: 'pending', total_count: 0, statuses: [] },
      }),
    },
    checks: {
      listForRef: vi.fn().mockResolvedValue({ data: { check_runs: [] } }),
    },
    paginate: paginateFn,
    request: vi.fn().mockRejectedValue(new Error('not mocked')),
  } as unknown as import('@octokit/rest').Octokit;
}

// ============================================================================
// T012 — waitState in poll response agent entries
// ============================================================================

describe('prPollUpdates — waitState in agent entries when include=[agents]', () => {
  it('includes waitState on non-ready agents when include contains agents', async () => {
    const client = makeMockClient();
    // since is 2 minutes ago — within coderabbit's 5-minute expected window → normal
    const since = new Date(Date.now() - 120_000).toISOString();
    const octokit = makeMockOctokit();

    const result = await prPollUpdates(
      { owner: 'acme', repo: 'api', pr: 1, compact: true, since, include: ['agents'] },
      client,
      octokit,
    );

    const agentsStatus = result.updates.agentsStatus;
    expect(agentsStatus).not.toBeNull();

    // At least one agent entry should be present (default agents = coderabbit)
    expect(agentsStatus!.agents.length).toBeGreaterThan(0);

    for (const agent of agentsStatus!.agents) {
      if (!agent.ready) {
        // Non-ready agents must have a waitState
        expect(agent.waitState).toBeDefined();
        expect(['normal', 'slow', 'stalled', 'provider_limit', 'timed_out']).toContain(agent.waitState);
        expect(typeof agent.expectedTimeExceeded).toBe('boolean');
      }
    }
  });

  it('omits agentsStatus when agents not in include list', async () => {
    const client = makeMockClient();
    const since = new Date(Date.now() - 60_000).toISOString();
    const octokit = makeMockOctokit();

    const result = await prPollUpdates(
      { owner: 'acme', repo: 'api', pr: 2, compact: true, since, include: ['commits'] },
      client,
      octokit,
    );

    expect(result.updates.agentsStatus).toBeNull();
  });

  it('ready agents do not have waitState set', async () => {
    const client = makeMockClient();
    const since = new Date(Date.now() - 60_000).toISOString();
    const octokit = makeMockOctokit();

    const result = await prPollUpdates(
      { owner: 'acme', repo: 'api', pr: 3, compact: true, since, include: ['agents'] },
      client,
      octokit,
    );

    const agentsStatus = result.updates.agentsStatus;
    if (agentsStatus) {
      for (const agent of agentsStatus.agents) {
        if (agent.ready) {
          // Ready agents keep original shape — waitState not injected
          expect(agent.waitState).toBeUndefined();
        }
      }
    }
  });
});
