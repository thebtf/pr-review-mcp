/**
 * Tests for branch protection logic in buildContext / generateReviewPrompt
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GitHubClient } from '../github/client.js';
import type { ListPRsOutput, PRInfo } from '../tools/list-prs.js';

// Mock all external dependencies
vi.mock('../git/detect.js', () => ({
  detectCurrentBranch: vi.fn(),
  detectGitRepo: vi.fn(),
  isDefaultBranch: vi.fn()
}));

vi.mock('../tools/list-prs.js', () => ({
  prListPRs: vi.fn()
}));

vi.mock('../tools/summary.js', () => ({
  prSummary: vi.fn()
}));

vi.mock('../tools/coordination.js', () => ({
  prGetWorkStatus: vi.fn()
}));

vi.mock('../agents/registry.js', () => ({
  getEnvConfig: vi.fn(() => ({
    agents: ['coderabbit'] as const,
    mode: 'sequential' as const
  }))
}));

vi.mock('../logging.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warning: vi.fn(),
    error: vi.fn()
  }
}));

import { generateReviewPrompt } from './review.js';
import { detectCurrentBranch, detectGitRepo, isDefaultBranch } from '../git/detect.js';
import { prListPRs } from '../tools/list-prs.js';
import { prSummary } from '../tools/summary.js';
import { prGetWorkStatus } from '../tools/coordination.js';

const mockDetectBranch = vi.mocked(detectCurrentBranch);
const mockDetectRepo = vi.mocked(detectGitRepo);
const mockIsDefault = vi.mocked(isDefaultBranch);
const mockListPRs = vi.mocked(prListPRs);
const mockSummary = vi.mocked(prSummary);
const mockWorkStatus = vi.mocked(prGetWorkStatus);

const fakeClient = {} as GitHubClient;

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 5,
    title: 'Test PR',
    state: 'OPEN',
    isDraft: false,
    author: 'user',
    branch: 'feat/X',
    baseBranch: 'main',
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    stats: { additions: 10, deletions: 2, changedFiles: 3, reviewThreads: 2, comments: 5 },
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides
  };
}

function makeListPRsOutput(prs: PRInfo[]): ListPRsOutput {
  return {
    repo: 'owner/repo',
    total: prs.length,
    returned: prs.length,
    state: 'OPEN',
    pullRequests: prs
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockIsDefault.mockReturnValue(false);
  // Default: detectGitRepo returns matching repo (sameRepo = true for branch protection)
  mockDetectRepo.mockReturnValue({ owner: 'owner', repo: 'repo' });
  mockWorkStatus.mockResolvedValue({ isActive: false, runAge: null } as any);
  mockSummary.mockResolvedValue({
    total: 5, resolved: 3, unresolved: 2, bySeverity: { medium: 2 },
    byFile: {}, bySource: {}, repo: 'owner/repo', pr: 5
  } as any);
});

describe('branch protection: PR mismatch guard', () => {
  it('refuses when branch has PR and user requests different PR', async () => {
    mockDetectBranch.mockReturnValue('feat/X');
    // detectGitRepo returns same repo → sameRepo = true → branch protection active
    mockListPRs.mockResolvedValue(makeListPRsOutput([makePR({ number: 5, branch: 'feat/X' })]));

    const result = await generateReviewPrompt(
      { owner: 'owner', repo: 'repo', pr: '7' },
      fakeClient
    );

    expect(result).toContain('Branch Protection: PR Mismatch');
    expect(result).toContain('PR #5');
    expect(result).toContain('PR #7');
    expect(result).toContain('feat/X');
  });

  it('allows when branch has PR and user requests same PR', async () => {
    mockDetectBranch.mockReturnValue('feat/X');
    mockListPRs.mockResolvedValue(makeListPRsOutput([makePR({ number: 5, branch: 'feat/X' })]));

    const result = await generateReviewPrompt(
      { owner: 'owner', repo: 'repo', pr: '5' },
      fakeClient
    );

    expect(result).not.toContain('Branch Protection');
    expect(result).toContain('#5');
    // Should be auto-detected single PR flow
    expect(result).toContain('auto-detected from branch');
  });

  it('auto-detects PR when no PR arg provided', async () => {
    mockDetectBranch.mockReturnValue('feat/X');
    mockListPRs.mockResolvedValue(makeListPRsOutput([makePR({ number: 5, branch: 'feat/X' })]));

    const result = await generateReviewPrompt(
      { owner: 'owner', repo: 'repo' },
      fakeClient
    );

    expect(result).not.toContain('Branch Protection');
    expect(result).toContain('#5');
    expect(result).toContain('auto-detected from branch `feat/X`');
  });

  it('bypasses protection on default branch', async () => {
    mockDetectBranch.mockReturnValue('main');
    mockIsDefault.mockReturnValue(true);

    const result = await generateReviewPrompt(
      { owner: 'owner', repo: 'repo', pr: '7' },
      fakeClient
    );

    expect(result).not.toContain('Branch Protection');
    // Should proceed to normal single PR flow
    expect(result).toContain('#7');
  });

  it('passes through when branch has no matching PR', async () => {
    mockDetectBranch.mockReturnValue('feat/Y');
    mockListPRs.mockResolvedValue(makeListPRsOutput([makePR({ number: 5, branch: 'feat/X' })]));

    const result = await generateReviewPrompt(
      { owner: 'owner', repo: 'repo', pr: '7' },
      fakeClient
    );

    expect(result).not.toContain('Branch Protection');
    // Should hit explicit PR flow
    expect(result).toContain('#7');
  });

  it('fails open when git detection fails', async () => {
    mockDetectBranch.mockReturnValue(null);

    const result = await generateReviewPrompt(
      { owner: 'owner', repo: 'repo', pr: '7' },
      fakeClient
    );

    expect(result).not.toContain('Branch Protection');
    expect(result).toContain('#7');
  });

  it('fails open when prListPRs throws', async () => {
    mockDetectBranch.mockReturnValue('feat/X');
    mockListPRs.mockRejectedValueOnce(new Error('API error'));
    // Second call for explicit PR flow — summary+workStatus should succeed
    mockSummary.mockResolvedValue({
      total: 5, resolved: 3, unresolved: 2, bySeverity: { medium: 2 },
      byFile: {}, bySource: {}, repo: 'owner/repo', pr: 7
    } as any);

    const result = await generateReviewPrompt(
      { owner: 'owner', repo: 'repo', pr: '7' },
      fakeClient
    );

    expect(result).not.toContain('Branch Protection');
    expect(result).toContain('#7');
  });

  it('caches prListPRs result for multi-PR mode', async () => {
    mockDetectBranch.mockReturnValue('feat/Y');
    const prs = [
      makePR({ number: 5, branch: 'feat/X' }),
      makePR({ number: 8, branch: 'feat/Z' })
    ];
    mockListPRs.mockResolvedValue(makeListPRsOutput(prs));

    // No PR arg — should go through branch detection (no match for feat/Y)
    // then fall to multi-PR mode using cached result
    const result = await generateReviewPrompt(
      { owner: 'owner', repo: 'repo' },
      fakeClient
    );

    // prListPRs should be called only ONCE (cached for multi-PR mode)
    expect(mockListPRs).toHaveBeenCalledTimes(1);
    expect(result).not.toContain('Branch Protection');
  });
});
