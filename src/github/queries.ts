/**
 * GraphQL Queries for GitHub API
 */

export const QUERIES = {
  /**
   * List all review threads with pagination
   */
  listThreads: `
    query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          reviewThreads(first: 20, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            totalCount
            nodes {
              id
              isResolved
              isOutdated
              viewerCanResolve
              path
              line
              diffSide
              comments(first: 50) {
                nodes {
                  id
                  body
                  createdAt
                  updatedAt
                  author { login }
                }
              }
            }
          }
        }
      }
    }
  `,

  /**
   * Resolve a review thread
   */
  resolveThread: `
    mutation($threadId: ID!, $clientMutationId: String) {
      resolveReviewThread(input: { threadId: $threadId, clientMutationId: $clientMutationId }) {
        thread {
          id
          isResolved
        }
      }
    }
  `,

  /**
   * Unresolve a review thread
   */
  unresolveThread: `
    mutation($threadId: ID!, $clientMutationId: String) {
      unresolveReviewThread(input: { threadId: $threadId, clientMutationId: $clientMutationId }) {
        thread {
          id
          isResolved
        }
      }
    }
  `,

  /**
   * Get PR reviews (for extracting CodeRabbit nitpicks from review bodies)
   */
  listReviews: `
    query($owner: String!, $repo: String!, $pr: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          reviews(first: 50) {
            nodes {
              id
              body
              state
              author { login }
            }
          }
        }
      }
    }
  `
} as const;
