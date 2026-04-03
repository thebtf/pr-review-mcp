/**
 * AgentCompletionDetector — unified engine for detecting AI review agent completion.
 *
 * Replaces the divergent detector.ts (GraphQL + check runs) and status.ts (REST only)
 * with a single per-agent strategy-based detection system.
 *
 * Each agent defines a CompletionStrategy in registry.ts that specifies:
 * - Which API sources to check (reviews, issue_comments, check_runs)
 * - Body patterns that confirm completion (regex)
 * - Exclude patterns that reject false positives (placeholders, errors)
 * - Expected and max wait times for per-agent timeout
 */

import type { Octokit } from '@octokit/rest';
import { getOctokit } from '../github/octokit.js';
import {
  INVOKABLE_AGENTS,
  getDefaultAgents,
  type AgentConfig,
  type CompletionSource,
  type InvokableAgentId,
} from './registry.js';
import { logger } from '../logging.js';

// ============================================================================
// Types
// ============================================================================

export type CompletionConfidence = 'high' | 'medium' | 'low';

export interface AgentCompletionResult {
  agentId: InvokableAgentId;
  name: string;
  ready: boolean;
  /** How confident we are that the agent truly completed */
  confidence: CompletionConfidence;
  /** Which source confirmed completion */
  source?: CompletionSource;
  /** ISO timestamp of the activity that confirmed completion */
  lastActivity?: string;
  /** Human-readable detail for logging */
  detail?: string;
}

export interface CompletionDetectionResult {
  allReady: boolean;
  agents: AgentCompletionResult[];
  fetchedAt: string;
}

/** Backward-compatible alias for ReviewMonitor consumers */
export interface AgentStatus {
  agentId: InvokableAgentId;
  name: string;
  ready: boolean;
  lastComment?: string;
}

export interface AgentsStatus {
  allAgentsReady: boolean;
  agents: AgentStatus[];
}

// ============================================================================
// Author Matching (single implementation — replaces divergent versions)
// ============================================================================

/**
 * Check if a GitHub login matches an agent's author pattern.
 * Normalizes both sides: lowercase, strip [bot] suffix.
 * Supports string | string[] patterns.
 */
export function matchesAuthorPattern(login: string, pattern: string | string[]): boolean {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  const normalize = (s: string): string =>
    s.trim().toLowerCase().replace(/\[bot\]$/, '');
  const normLogin = normalize(login);
  return patterns.some(p => normLogin === normalize(p));
}

// ============================================================================
// Pagination Helper
// ============================================================================

async function paginateWithLimit<T>(
  iterator: AsyncIterable<{ data: T[] }>,
  limit: number,
): Promise<T[]> {
  // Collect all pages, keeping only the last `limit` items so that the `since`
  // filter applied by callers sees the most-recent activity rather than the
  // oldest `limit` entries (GitHub returns items in ascending chronological order).
  const results: T[] = [];
  for await (const page of iterator) {
    results.push(...page.data);
    if (results.length > limit) {
      results.splice(0, results.length - limit);
    }
  }
  return results;
}

// ============================================================================
// Raw Data Types (from GitHub API)
// ============================================================================

interface RawReview {
  user: { login: string } | null;
  state: string;
  submitted_at?: string | null;
  body: string | null;
}

interface RawIssueComment {
  user: { login: string } | null;
  created_at: string;
  updated_at?: string;
  body?: string;
}

interface RawCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  app?: { slug?: string } | null;
  completed_at?: string | null;
}

// ============================================================================
// Core Detection
// ============================================================================

/**
 * Fetch completion status for a set of agents.
 * Parallel-fetches only the API sources that the requested agents need.
 */
export async function fetchCompletionStatus(
  owner: string,
  repo: string,
  pr: number,
  agents: InvokableAgentId[],
  since: string | null,
  octokit?: Octokit,
  headSha?: string,
): Promise<CompletionDetectionResult> {
  const ok = octokit ?? getOctokit();
  const sinceDate = since ? new Date(since) : null;

  // Determine which sources we need across all agents
  const neededSources = new Set<CompletionSource>();
  for (const agentId of agents) {
    const config = INVOKABLE_AGENTS[agentId];
    if (config) {
      for (const source of config.completionStrategy.sources) {
        neededSources.add(source);
      }
    }
  }

  // Parallel fetch only needed sources
  const [reviews, issueComments, checkRuns] = await Promise.all([
    neededSources.has('reviews')
      ? fetchReviews(ok, owner, repo, pr)
      : Promise.resolve([]),
    neededSources.has('issue_comments')
      ? fetchIssueComments(ok, owner, repo, pr)
      : Promise.resolve([]),
    neededSources.has('check_runs') && headSha
      ? fetchCheckRuns(ok, owner, repo, headSha)
      : neededSources.has('check_runs')
        ? fetchHeadShaAndCheckRuns(ok, owner, repo, pr)
        : Promise.resolve([]),
  ]);

  // Evaluate each agent
  const agentResults: AgentCompletionResult[] = agents.map(agentId => {
    const config = INVOKABLE_AGENTS[agentId];
    if (!config) {
      return {
        agentId,
        name: agentId,
        ready: false,
        confidence: 'low' as CompletionConfidence,
          detail: 'Unknown agent',
      };
    }

    return evaluateAgent(agentId, config, reviews, issueComments, checkRuns, sinceDate);
  });

  const allReady = agentResults.every(a => a.ready);

  return {
    allReady,
    agents: agentResults,
    fetchedAt: new Date().toISOString(),
  };
}

// ============================================================================
// Per-Agent Evaluation
// ============================================================================

function evaluateAgent(
  agentId: InvokableAgentId,
  config: AgentConfig,
  reviews: RawReview[],
  issueComments: RawIssueComment[],
  checkRuns: RawCheckRun[],
  sinceDate: Date | null,
): AgentCompletionResult {
  const strategy = config.completionStrategy;
  const { authorPattern } = config;

  // Try each source in priority order
  for (const source of strategy.sources) {
    switch (source) {
      case 'check_runs': {
        const result = evaluateCheckRuns(agentId, config, checkRuns);
        if (result) return result;
        break;
      }
      case 'reviews': {
        const result = evaluateReviews(agentId, config, reviews, sinceDate);
        if (result) return result;
        break;
      }
      case 'issue_comments': {
        const result = evaluateIssueComments(agentId, config, issueComments, sinceDate);
        if (result) return result;
        break;
      }
    }
  }

  // No completion signal found
  return {
    agentId,
    name: config.name,
    ready: false,
    confidence: 'low',
  };
}

function evaluateCheckRuns(
  agentId: InvokableAgentId,
  config: AgentConfig,
  checkRuns: RawCheckRun[],
): AgentCompletionResult | null {
  const slugs = config.completionStrategy.checkRunAppSlugs;
  if (!slugs || slugs.length === 0) return null;

  const slugSet = new Set(slugs.map(s => s.toLowerCase()));

  for (const cr of checkRuns) {
    const appSlug = cr.app?.slug?.toLowerCase() ?? '';
    if (!slugSet.has(appSlug)) continue;

    if (cr.status === 'completed') {
      return {
        agentId,
        name: config.name,
        ready: true,
        confidence: 'medium',
        source: 'check_runs',
        lastActivity: cr.completed_at ?? undefined,
          detail: `Check run "${cr.name}" completed (conclusion: ${cr.conclusion})`,
      };
    }
  }

  return null;
}

function evaluateReviews(
  agentId: InvokableAgentId,
  config: AgentConfig,
  reviews: RawReview[],
  sinceDate: Date | null,
): AgentCompletionResult | null {
  const strategy = config.completionStrategy;

  // Filter by author
  const agentReviews = reviews.filter(r =>
    r.user && matchesAuthorPattern(r.user.login, config.authorPattern),
  );

  // Filter out PENDING if strategy requires
  const submitted = strategy.filterPendingReviews
    ? agentReviews.filter(r => r.state !== 'PENDING')
    : agentReviews;

  // Filter by since timestamp
  const fresh = sinceDate
    ? submitted.filter(r =>
        r.submitted_at && new Date(r.submitted_at) > sinceDate,
      )
    : submitted;

  if (fresh.length === 0) return null;

  // Find best match: prefer reviews whose body matches bodyPattern
  for (const review of fresh) {
    const body = review.body ?? '';

    // Check exclude patterns first
    if (strategy.excludePatterns?.some(p => p.test(body))) {
      logger.debug(`[completion] ${agentId}: review excluded by pattern match`);
      continue;
    }

    // Check body pattern
    const bodyMatches = strategy.bodyPattern ? strategy.bodyPattern.test(body) : true;

    // CodeRabbit APPROVED reviews have empty body — that's valid
    if (agentId === 'coderabbit' && review.state === 'APPROVED' && body === '') {
      return {
        agentId,
        name: config.name,
        ready: true,
        confidence: 'high',
        source: 'reviews',
        lastActivity: review.submitted_at ?? undefined,
          detail: `Review APPROVED (no issues found)`,
      };
    }

    if (bodyMatches) {
      return {
        agentId,
        name: config.name,
        ready: true,
        confidence: 'high',
        source: 'reviews',
        lastActivity: review.submitted_at ?? undefined,
          detail: `Review ${review.state} with body match`,
      };
    }
  }

  // Fallback: author matched + submitted after since, but no bodyPattern is configured.
  // When bodyPattern IS defined but didn't match, we must NOT accept the review — it may
  // be a placeholder or error body that the exclude patterns didn't catch.
  if (!strategy.bodyPattern) {
    const latest = fresh[fresh.length - 1];
    if (latest) {
      const body = latest.body ?? '';
      if (!strategy.excludePatterns?.some(p => p.test(body))) {
        return {
          agentId,
          name: config.name,
          ready: true,
          confidence: 'medium',
          source: 'reviews',
          lastActivity: latest.submitted_at ?? undefined,
          detail: `Review ${latest.state} (no bodyPattern configured; author + timestamp valid)`,
        };
      }
    }
  }

  return null;
}

function evaluateIssueComments(
  agentId: InvokableAgentId,
  config: AgentConfig,
  issueComments: RawIssueComment[],
  sinceDate: Date | null,
): AgentCompletionResult | null {
  const strategy = config.completionStrategy;

  // Filter by author
  const agentComments = issueComments.filter(c =>
    c.user && matchesAuthorPattern(c.user.login, config.authorPattern),
  );

  // Filter by since timestamp (use updated_at for persistent comments, created_at otherwise)
  const fresh = sinceDate
    ? agentComments.filter(c => {
        const ts = c.updated_at ?? c.created_at;
        return new Date(ts) > sinceDate;
      })
    : agentComments;

  if (fresh.length === 0) return null;

  // Check body patterns (most recent first)
  const sorted = [...fresh].sort((a, b) => {
    const tsA = new Date(a.updated_at ?? a.created_at).getTime();
    const tsB = new Date(b.updated_at ?? b.created_at).getTime();
    return tsB - tsA;
  });

  for (const comment of sorted) {
    const body = comment.body ?? '';

    // Check exclude patterns
    if (strategy.excludePatterns?.some(p => p.test(body))) {
      continue;
    }

    // Check body pattern
    const bodyMatches = strategy.bodyPattern ? strategy.bodyPattern.test(body) : true;

    if (bodyMatches) {
      const ts = comment.updated_at ?? comment.created_at;
      return {
        agentId,
        name: config.name,
        ready: true,
        confidence: 'high',
        source: 'issue_comments',
        lastActivity: ts,
          detail: `Issue comment with body match`,
      };
    }
  }

  return null;
}

// ============================================================================
// Data Fetching
// ============================================================================

/**
 * Returns the HTTP status code from an Octokit or fetch error, or null if not determinable.
 */
function getErrorStatus(error: unknown): number | null {
  const errObj = error as { status?: unknown; response?: { status?: unknown } } | null;
  if (errObj && typeof errObj.status === 'number') return errObj.status;
  if (errObj?.response && typeof errObj.response.status === 'number') return errObj.response.status;
  if (error instanceof Error) {
    const match = /\b(403|429)\b/.exec(error.message);
    if (match) return Number(match[0]);
  }
  return null;
}

/**
 * Returns true for rate-limit and abuse-detection errors that ReviewMonitor should back off on.
 * These errors must propagate so the monitor's throttling logic can engage.
 */
function isRetryableApiError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status === 429) return true;
  if (status === 403) {
    const msg = error instanceof Error ? error.message.toLowerCase() : '';
    return msg.includes('rate limit') || msg.includes('abuse detection') || msg.includes('secondary rate');
  }
  return false;
}

async function fetchReviews(
  ok: Octokit,
  owner: string,
  repo: string,
  pr: number,
): Promise<RawReview[]> {
  try {
    return await paginateWithLimit(
      ok.paginate.iterator(ok.pulls.listReviews, {
        owner,
        repo,
        pull_number: pr,
        per_page: 100,
      }),
      200,
    );
  } catch (error) {
    if (isRetryableApiError(error)) throw error;
    logger.warning(`[completion] Failed to fetch reviews: ${error}`);
    return [];
  }
}

async function fetchIssueComments(
  ok: Octokit,
  owner: string,
  repo: string,
  pr: number,
): Promise<RawIssueComment[]> {
  try {
    return await paginateWithLimit(
      ok.paginate.iterator(ok.issues.listComments, {
        owner,
        repo,
        issue_number: pr,
        per_page: 100,
      }),
      200,
    );
  } catch (error) {
    if (isRetryableApiError(error)) throw error;
    logger.warning(`[completion] Failed to fetch issue comments: ${error}`);
    return [];
  }
}

async function fetchCheckRuns(
  ok: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<RawCheckRun[]> {
  try {
    const runs = await ok.paginate(ok.checks.listForRef, {
      owner,
      repo,
      ref,
    });
    return runs.map(cr => ({
      name: cr.name,
      status: cr.status,
      conclusion: cr.conclusion,
      app: cr.app ? { slug: cr.app.slug } : undefined,
      completed_at: cr.completed_at,
    }));
  } catch (error) {
    if (isRetryableApiError(error)) throw error;
    logger.debug(`[completion] Failed to fetch check runs: ${error}`);
    return [];
  }
}

async function fetchHeadShaAndCheckRuns(
  ok: Octokit,
  owner: string,
  repo: string,
  pr: number,
): Promise<RawCheckRun[]> {
  try {
    const prData = await ok.pulls.get({ owner, repo, pull_number: pr });
    return fetchCheckRuns(ok, owner, repo, prData.data.head.sha);
  } catch (error) {
    if (isRetryableApiError(error)) throw error;
    logger.debug(`[completion] Failed to fetch head SHA for check runs: ${error}`);
    return [];
  }
}

// ============================================================================
// Backward-Compatible Wrappers
// ============================================================================

/**
 * Fetch agent completion status for configured default agents.
 * Drop-in replacement for the old status.ts fetchAgentStatus().
 */
export async function fetchAgentStatus(
  owner: string,
  repo: string,
  pr: number,
  since: string | null,
  octokit?: Octokit,
): Promise<AgentsStatus> {
  return fetchAgentStatusForAgents(owner, repo, pr, getDefaultAgents(), since, octokit);
}

/**
 * Fetch agent completion status for specific agents.
 * Drop-in replacement for the old status.ts fetchAgentStatusForAgents().
 */
export async function fetchAgentStatusForAgents(
  owner: string,
  repo: string,
  pr: number,
  agents: InvokableAgentId[],
  since: string | null,
  octokit?: Octokit,
): Promise<AgentsStatus> {
  const result = await fetchCompletionStatus(owner, repo, pr, agents, since, octokit);

  // Map to old AgentStatus format
  const agentStatuses: AgentStatus[] = result.agents.map(a => ({
    agentId: a.agentId,
    name: a.name,
    ready: a.ready,
    lastComment: a.lastActivity,
  }));

  return {
    allAgentsReady: result.allReady,
    agents: agentStatuses,
  };
}
