/**
 * GitHub API Types
 */

export interface GraphQLVariables {
  [key: string]: string | number | boolean | null | undefined;
}

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface Author {
  login: string;
}

export interface ReviewComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: Author | null;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  viewerCanResolve: boolean;
  path: string;
  line: number | null;
  diffSide: string;
  comments: {
    nodes: ReviewComment[];
  };
}

export interface ReviewThreadsResponse {
  pageInfo: PageInfo;
  totalCount: number;
  nodes: ReviewThread[];
}

export interface PullRequestResponse {
  reviewThreads: ReviewThreadsResponse;
}

export interface RepositoryResponse {
  pullRequest: PullRequestResponse | null;
}

export interface ListThreadsData {
  repository: RepositoryResponse | null;
}

export interface ResolveThreadData {
  resolveReviewThread: {
    thread: {
      id: string;
      isResolved: boolean;
    };
  };
}

export interface UnresolveThreadData {
  unresolveReviewThread: {
    thread: {
      id: string;
      isResolved: boolean;
    };
  };
}

export interface PRReview {
  id: string;
  body: string;
  state: string;
  author: Author | null;
}

export interface ListReviewsData {
  repository: {
    pullRequest: {
      reviews: {
        nodes: PRReview[];
      };
    } | null;
  } | null;
}

export interface GraphQLError {
  type?: string;
  message: string;
  path?: string[];
}

export interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
}

// Comment source types
export type CommentSource = 'coderabbit' | 'gemini' | 'codex' | 'copilot' | 'sourcery' | 'qodo' | 'unknown';

// Processed comment type
export interface ProcessedComment {
  id: string;
  threadId: string;
  file: string;
  line: number | string;
  outdated: boolean;
  resolved: boolean;
  canResolve: boolean;
  severity: string;
  type: string;
  source: CommentSource;
  title: string;
  body: string;
  fullBody: string;
  aiPrompt: string | null;
  aiPromptConfidence: 'high' | 'low' | 'absent';
  author: string;
  createdAt: string | undefined;
  updatedAt: string | undefined;
  replies: ProcessedReply[];
}

export interface ProcessedReply {
  id: string;
  body: string;
  author: string;
  createdAt: string;
}

// Tool input/output types
export interface SummaryInput {
  owner: string;
  repo: string;
  pr: number;
}

export interface SummaryOutput {
  pr: string;
  total: number;
  resolved: number;
  unresolved: number;
  outdated: number;
  bySeverity: Record<string, number>;
  byFile: Record<string, number>;
  nitpicks?: {
    total: number;
    resolved: number;
    unresolved: number;
  };
}

export interface ListFilter {
  resolved?: boolean;
  outdated?: boolean;
  file?: string;
  author?: string;
}

export interface ListInput {
  owner: string;
  repo: string;
  pr: number;
  filter?: ListFilter;
  max?: number;
}

export interface ListComment {
  id: string;
  threadId: string;
  file: string;
  line: number | string;
  severity: string;
  source: CommentSource;
  title: string;
  resolved: boolean;
  hasAiPrompt: boolean;
}

export interface ListOutput {
  comments: ListComment[];
  total: number;
  hasMore: boolean;
}

export interface GetInput {
  owner: string;
  repo: string;
  pr: number;
  id: string;
}

export interface GetOutput {
  id: string;
  threadId: string;
  file: string;
  line: number | string;
  severity: string;
  source: CommentSource;
  title: string;
  body: string;
  aiPrompt: {
    text: string;
    confidence: 'high' | 'low';
  } | null;
  replies: ProcessedReply[];
  canResolve: boolean;
}

export interface ResolveInput {
  owner: string;
  repo: string;
  threadId: string;
}

export interface ResolveOutput {
  success: boolean;
  threadId?: string;
  file?: string;
  title?: string;
  synthetic?: boolean;
  message?: string;
}

export interface ChangesInput {
  owner: string;
  repo: string;
  pr: number;
  cursor?: string;
  max?: number;
}

export interface ChangesOutput {
  comments: ListComment[];
  cursor: string | null;
  hasMore: boolean;
}
