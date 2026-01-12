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
  `,

  /**
   * List all pull requests in a repository
   */
  listPullRequests: `
    query($owner: String!, $repo: String!, $states: [PullRequestState!], $first: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequests(states: $states, first: $first, after: $cursor, orderBy: {field: CREATED_AT, direction: DESC}) {
          pageInfo {
            hasNextPage
            endCursor
          }
          totalCount
          nodes {
            number
            title
            state
            isDraft
            createdAt
            updatedAt
            author { login }
            baseRefName
            headRefName
            mergeable
            reviewDecision
            additions
            deletions
            changedFiles
            reviewThreads(first: 50) {
              totalCount
              nodes {
                isResolved
              }
            }
            comments {
              totalCount
            }
          }
        }
      }
    }
  `,

  /**
   * Get a single pull request by number
   */
  getPullRequest: `
    query($owner: String!, $repo: String!, $pr: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          number
          title
          state
          isDraft
          createdAt
          updatedAt
          author { login }
          baseRefName
          headRefName
          mergeable
          reviewDecision
        }
      }
    }
  `,

  /**
   * Add reaction to a subject (comment, review, etc.)
   * Reaction content: THUMBS_UP, THUMBS_DOWN, LAUGH, HOORAY, CONFUSED, HEART, ROCKET, EYES
   */
  addReaction: `
    mutation($subjectId: ID!, $content: ReactionContent!) {
      addReaction(input: { subjectId: $subjectId, content: $content }) {
        reaction {
          content
        }
        subject {
          id
        }
      }
    }
  `
} as const;
