/**
 * Shared utilities for tools
 */

import { GitHubClient, StructuredError } from '../github/client.js';
import { QUERIES } from '../github/queries.js';
import type {
  ListThreadsData,
  ReviewThread,
  ProcessedComment,
  ProcessedReply,
  ListFilter
} from '../github/types.js';
import { extractPrompt, extractTitle, truncateBody } from '../extractors/prompt.js';
import { extractSeverity } from '../extractors/severity.js';

/**
 * Process GraphQL thread into comment object
 */
export function processThread(thread: ReviewThread): ProcessedComment {
  const firstComment = thread.comments?.nodes?.[0];
  const body = firstComment?.body || '';
  const { severity, type } = extractSeverity(body);
  const extraction = extractPrompt(body);

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
    title: extractTitle(body),
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
 * Fetch all threads with pagination
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
      return { comments, totalCount, cursor, hasMore: false };
    }
    cursor = threads.pageInfo.endCursor;
  }

  // Reached maxItems but more pages exist
  return { comments, totalCount, cursor, hasMore: true };
}
