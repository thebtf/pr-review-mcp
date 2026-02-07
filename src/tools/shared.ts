/**
 * Shared utilities for tools
 */

import { GitHubClient, StructuredError } from '../github/client.js';
import { QUERIES } from '../github/queries.js';
import type {
  ListThreadsData,
  ListReviewsData,
  ReviewThread,
  ProcessedComment,
  ProcessedReply,
  ListFilter
} from '../github/types.js';
import { extractPrompt, extractTitle, truncateBody } from '../extractors/prompt.js';
import { extractSeverity } from '../extractors/severity.js';
import { logger } from '../logging.js';
import {
  parseNitpicksFromReviewBody,
  nitpickToProcessedComment,
  parseOutsideDiffComments,
  outsideDiffToProcessedComment
} from '../extractors/coderabbit-nitpicks.js';
import { detectMultiIssue, splitMultiIssue } from '../extractors/multi-issue.js';
import { stateManager } from '../coordination/state.js';

/**
 * Fetch CodeRabbit review bodies and extract nitpicks + outside diff range comments
 */
async function fetchCodeRabbitNitpicks(
  client: GitHubClient,
  owner: string,
  repo: string,
  pr: number
): Promise<ProcessedComment[]> {
  try {
    const data = await client.graphql<ListReviewsData>(QUERIES.listReviews, {
      owner,
      repo,
      pr
    });

    const reviews = data?.repository?.pullRequest?.reviews?.nodes || [];

    // Filter for CodeRabbit reviews only, newest first
    const coderabbitReviews = reviews
      .filter(r => r.author?.login === 'coderabbitai' || r.author?.login === 'coderabbit[bot]')
      .reverse(); // GraphQL returns oldest first; reverse to get newest first

    if (coderabbitReviews.length === 0) return [];

    // Parse only the latest review (belt-and-suspenders with content-based dedup).
    // CodeRabbit re-generates the full nitpick/outside-diff sections on each push,
    // so older reviews contain stale duplicates.
    // Fallback: if latest review parses to zero, try previous reviews.
    // Note: Both nitpick and outside-diff sections are always present together in the
    // same review body — CodeRabbit regenerates both on each pass. The `||` below is
    // safe: finding either section means this is the active review with current data.
    let allNitpicks: ReturnType<typeof parseNitpicksFromReviewBody> = [];
    let allOutsideDiff: ReturnType<typeof parseOutsideDiffComments> = [];

    for (const review of coderabbitReviews) {
      allNitpicks = parseNitpicksFromReviewBody(review.body);
      allOutsideDiff = parseOutsideDiffComments(review.body);
      if (allNitpicks.length > 0 || allOutsideDiff.length > 0) break;
    }

    // Convert to ProcessedComment format
    const initialComments = [
      ...allNitpicks.map(nitpickToProcessedComment),
      ...allOutsideDiff.map(outsideDiffToProcessedComment)
    ];

    // Handle Multi-Issue Comments
    const finalComments: ProcessedComment[] = [];
    for (const comment of initialComments) {
      if (detectMultiIssue(comment.body)) {
        const children = splitMultiIssue(comment, comment.body);
        const childIds = children.map(c => c.id);
        
        // Register in state manager
        await stateManager.registerParentChild(comment.id, childIds, { owner, repo, pr });
        
        // Update resolution status from state
        for (const child of children) {
          child.resolved = await stateManager.isChildResolved(child.id, { owner, repo, pr });
        }
        
        // Add children instead of parent
        finalComments.push(...children);
      } else {
        finalComments.push(comment);
      }
    }

    return finalComments;
  } catch (error) {
    // Silently fail - nitpicks are a bonus, not critical
    logger.warning('Failed to fetch CodeRabbit nitpicks', { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

/**
 * Process GraphQL thread into comment object
 */
export function processThread(thread: ReviewThread): ProcessedComment {
  const firstComment = thread.comments?.nodes?.[0];
  const body = firstComment?.body || '';
  const author = firstComment?.author?.login;
  const { severity, type, source } = extractSeverity(body, author);
  const extraction = extractPrompt(body, source);

  return {
    id: firstComment?.id || thread.id,
    threadId: thread.id,
    file: thread.path || 'unknown',
    line: thread.line ?? '?',
    outdated: thread.isOutdated || false,
    resolved: thread.isResolved || false,
    canResolve: thread.viewerCanResolve || false,
    severity,
    type,
    source,
    title: extractTitle(body, source),
    body: truncateBody(body),
    fullBody: body,
    aiPrompt: extraction.prompt,
    aiPromptConfidence: extraction.confidence,
    author: firstComment?.author?.login || 'unknown',
    createdAt: firstComment?.createdAt,
    updatedAt: firstComment?.updatedAt,
    replies: (thread.comments?.nodes || []).slice(1).map(c => ({
      id: c.id,
      body: c.body,
      author: c.author?.login || 'unknown',
      createdAt: c.createdAt
    }))
  };
}

export interface FetchOptions {
  filter?: ListFilter;
  maxItems?: number;
  startCursor?: string | null;
}

export interface FetchResult {
  comments: ProcessedComment[];
  totalCount: number;
  cursor: string | null;
  hasMore: boolean;
}

/**
 * Fetch all threads with pagination, including CodeRabbit nitpicks
 */
export async function fetchAllThreads(
  client: GitHubClient,
  owner: string,
  repo: string,
  pr: number,
  options: FetchOptions = {}
): Promise<FetchResult> {
  const { filter = {}, maxItems = 100, startCursor = null } = options;
  const comments: ProcessedComment[] = [];
  let cursor = startCursor;
  let totalCount = 0;

  // Fetch inline threads and CodeRabbit nitpicks in parallel (only on first page)
  const nitpicksPromise = startCursor === null
    ? fetchCodeRabbitNitpicks(client, owner, repo, pr)
    : Promise.resolve([]);

  while (comments.length < maxItems) {
    const data = await client.graphql<ListThreadsData>(QUERIES.listThreads, {
      owner,
      repo,
      pr,
      cursor
    });

    const threads = data?.repository?.pullRequest?.reviewThreads;
    if (!threads) {
      throw new StructuredError('not_found', `PR #${pr} not found in ${owner}/${repo}`, false);
    }

    totalCount = threads.totalCount;

    for (const thread of threads.nodes) {
      const comment = processThread(thread);

      // Apply filters
      if (filter.resolved !== undefined && comment.resolved !== filter.resolved) continue;
      if (filter.outdated !== undefined && comment.outdated !== filter.outdated) continue;
      if (filter.file && !comment.file.includes(filter.file)) continue;
      if (filter.author && comment.author !== filter.author) continue;

      comments.push(comment);

      if (comments.length >= maxItems) break;
    }

    if (!threads.pageInfo.hasNextPage) {
      cursor = threads.pageInfo.endCursor;
      break;
    }
    cursor = threads.pageInfo.endCursor;
  }

  // Merge nitpicks (only on first page fetch)
  const nitpicks = await nitpicksPromise;
  if (nitpicks.length > 0 && startCursor === null) {
    const unresolvedNitpicks: ProcessedComment[] = [];
    for (const n of nitpicks) {
      const isResolved = await stateManager.isNitpickResolved(n.id, { owner, repo, pr });
      if (!isResolved) {
        unresolvedNitpicks.push(n);
      }
    }

    // Apply same filters to nitpicks
    const filteredNitpicks = unresolvedNitpicks.filter(comment => {
      if (filter.resolved !== undefined && comment.resolved !== filter.resolved) return false;
      if (filter.outdated !== undefined && comment.outdated !== filter.outdated) return false;
      if (filter.file && !comment.file.includes(filter.file)) return false;
      if (filter.author && comment.author !== filter.author) return false;
      return true;
    });

    // Prepend nitpicks to comments (they appear first as "synthetic" comments)
    // But respect maxItems limit - only add as many nitpicks as we have room for
    const roomForNitpicks = Math.max(0, maxItems - comments.length);
    const nitpicksToAdd = filteredNitpicks.slice(0, roomForNitpicks);
    comments.unshift(...nitpicksToAdd);

    // Adjust total count to include ALL unresolved nitpicks (for pagination awareness)
    totalCount += unresolvedNitpicks.length;
  }

  const hasMore = comments.length >= maxItems || totalCount > comments.length;
  return { comments, totalCount, cursor, hasMore };
}
