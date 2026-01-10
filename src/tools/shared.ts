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
import {
  parseNitpicksFromReviewBody,
  nitpickToProcessedComment,
  parseOutsideDiffComments,
  outsideDiffToProcessedComment
} from '../extractors/coderabbit-nitpicks.js';
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

    // Filter for CodeRabbit reviews only
    const coderabbitReviews = reviews.filter(r =>
      r.author?.login === 'coderabbitai' || r.author?.login === 'coderabbit[bot]'
    );

    // Extract nitpicks from each review body
    const allNitpicks = coderabbitReviews.flatMap(review =>
      parseNitpicksFromReviewBody(review.id, review.body)
    );

    // Extract outside diff range comments from each review body
    const allOutsideDiff = coderabbitReviews.flatMap(review =>
      parseOutsideDiffComments(review.id, review.body)
    );

    // Convert to ProcessedComment format and combine
    return [
      ...allNitpicks.map(nitpickToProcessedComment),
      ...allOutsideDiff.map(outsideDiffToProcessedComment)
    ];
  } catch (error) {
    // Silently fail - nitpicks are a bonus, not critical
    console.error('Failed to fetch CodeRabbit nitpicks:', error);
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
      const isResolved = await stateManager.isNitpickResolved(n.id);
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
    comments.unshift(...filteredNitpicks);

    // Adjust total count to include nitpicks
    totalCount += unresolvedNitpicks.length;
  }

  const hasMore = comments.length >= maxItems;
  return { comments, totalCount, cursor, hasMore };
}
