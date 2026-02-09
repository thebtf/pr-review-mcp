/**
 * Unit tests for git detection utilities
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectCurrentBranch, detectGitRepo, isDefaultBranch } from './detect.js';
import { execSync } from 'child_process';

vi.mock('child_process', () => ({
  execSync: vi.fn()
}));

const mockExecSync = vi.mocked(execSync);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('detectCurrentBranch', () => {
  it('returns branch name from git output', () => {
    mockExecSync.mockReturnValue('feat/my-feature\n');
    expect(detectCurrentBranch()).toBe('feat/my-feature');
  });

  it('returns "HEAD" for detached HEAD', () => {
    mockExecSync.mockReturnValue('HEAD\n');
    expect(detectCurrentBranch()).toBe('HEAD');
  });

  it('returns null when not in a git repo', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });
    expect(detectCurrentBranch()).toBeNull();
  });

  it('returns null for empty output', () => {
    mockExecSync.mockReturnValue('');
    expect(detectCurrentBranch()).toBeNull();
  });

  it('trims whitespace from output', () => {
    mockExecSync.mockReturnValue('  main  \n');
    expect(detectCurrentBranch()).toBe('main');
  });

  it('calls execSync with correct arguments', () => {
    mockExecSync.mockReturnValue('main\n');
    detectCurrentBranch();
    expect(mockExecSync).toHaveBeenCalledWith('git rev-parse --abbrev-ref HEAD', {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  });
});

describe('detectGitRepo', () => {
  it('parses SSH remote URL', () => {
    mockExecSync.mockReturnValue('git@github.com:thebtf/pr-review-mcp.git\n');
    expect(detectGitRepo()).toEqual({ owner: 'thebtf', repo: 'pr-review-mcp' });
  });

  it('parses SSH remote URL without .git suffix', () => {
    mockExecSync.mockReturnValue('git@github.com:owner/repo\n');
    expect(detectGitRepo()).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses HTTPS remote URL', () => {
    mockExecSync.mockReturnValue('https://github.com/owner/repo.git\n');
    expect(detectGitRepo()).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses HTTPS remote URL without .git suffix', () => {
    mockExecSync.mockReturnValue('https://github.com/owner/repo\n');
    expect(detectGitRepo()).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('returns null for non-GitHub remotes', () => {
    mockExecSync.mockReturnValue('git@gitlab.com:owner/repo.git\n');
    expect(detectGitRepo()).toBeNull();
  });

  it('returns null when not in a git repo', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });
    expect(detectGitRepo()).toBeNull();
  });

  it('returns null for empty output', () => {
    mockExecSync.mockReturnValue('');
    expect(detectGitRepo()).toBeNull();
  });

  it('handles SSH URL with ssh:// prefix', () => {
    mockExecSync.mockReturnValue('ssh://git@github.com/owner/repo.git\n');
    expect(detectGitRepo()).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('calls execSync with correct arguments', () => {
    mockExecSync.mockReturnValue('git@github.com:a/b.git\n');
    detectGitRepo();
    expect(mockExecSync).toHaveBeenCalledWith('git remote get-url origin', {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  });
});

describe('isDefaultBranch', () => {
  it('identifies main as default', () => {
    expect(isDefaultBranch('main')).toBe(true);
  });

  it('identifies master as default', () => {
    expect(isDefaultBranch('master')).toBe(true);
  });

  it('identifies dev as default', () => {
    expect(isDefaultBranch('dev')).toBe(true);
  });

  it('identifies develop as default', () => {
    expect(isDefaultBranch('develop')).toBe(true);
  });

  it('identifies HEAD as default (detached)', () => {
    expect(isDefaultBranch('HEAD')).toBe(true);
  });

  it('returns false for feature branches', () => {
    expect(isDefaultBranch('feat/my-feature')).toBe(false);
    expect(isDefaultBranch('fix/bug-123')).toBe(false);
    expect(isDefaultBranch('feature/new-thing')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(isDefaultBranch('Main')).toBe(false);
    expect(isDefaultBranch('MAIN')).toBe(false);
  });
});
