/**
 * Git Detection Utilities
 *
 * Detect current branch and repository from local git state.
 * Used by the review prompt to auto-target PRs from the current branch.
 */

import { execSync } from 'child_process';

const DEFAULT_BRANCHES = new Set(['main', 'master', 'dev', 'develop', 'HEAD']);

/**
 * Detect the current git branch name.
 * Returns null if not in a git repo, detached HEAD returns "HEAD".
 */
export function detectCurrentBranch(): string | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    return branch || null;
  } catch {
    return null;
  }
}

/**
 * Detect the GitHub owner/repo from the git remote origin URL.
 * Supports both SSH (git@github.com:owner/repo.git) and HTTPS (https://github.com/owner/repo.git) formats.
 * Returns null if not in a git repo or remote is not a GitHub URL.
 */
export function detectGitRepo(): { owner: string; repo: string } | null {
  try {
    const url = execSync('git remote get-url origin', {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    // SSH format: git@github.com:owner/repo.git
    const sshMatch = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/i);
    if (sshMatch) {
      return { owner: sshMatch[1], repo: sshMatch[2] };
    }

    // HTTPS format: https://github.com/owner/repo.git
    const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?$/i);
    if (httpsMatch) {
      return { owner: httpsMatch[1], repo: httpsMatch[2] };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Check if a branch name is a default/protected branch that should trigger multi-PR mode.
 */
export function isDefaultBranch(branch: string): boolean {
  return DEFAULT_BRANCHES.has(branch);
}
