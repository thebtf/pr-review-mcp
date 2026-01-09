/**
 * PR Review MCP Server
 *
 * Provides tools for processing PR reviews with GraphQL-based GitHub integration.
 * Features: cursor pagination (zero comments missed), 4-layer AI prompt extraction,
 * circuit breaker, and automated workflow prompt.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  Tool,
  Prompt,
} from '@modelcontextprotocol/sdk/types.js';

import { ZodError } from 'zod';
import { GitHubClient, StructuredError } from './github/client.js';
import { prSummary, SummaryInputSchema } from './tools/summary.js';
import { prList, ListInputSchema } from './tools/list.js';
import { prGet, GetInputSchema } from './tools/get.js';
import { prResolveWithContext, ResolveInputSchema } from './tools/resolve.js';
import { prChanges, ChangesInputSchema } from './tools/changes.js';
import { prInvoke, InvokeInputSchema } from './tools/invoke.js';
import { prPollUpdates, PollInputSchema } from './tools/poll.js';
import { prLabels, LabelsInputSchema } from './tools/labels.js';
import { prReviewers, ReviewersInputSchema } from './tools/reviewers.js';
import { prCreate, CreateInputSchema } from './tools/create.js';
import { prMerge, MergeInputSchema } from './tools/merge.js';

// ============================================================================
// Workflow Prompt
// ============================================================================

const PR_REVIEW_PROMPT = `I'll process PR review comments systematically until all are resolved.

## Phase 1: Discovery

1. Call \`pr_summary\` to get statistics
2. Note total, resolved, unresolved counts
3. Create todo list if unresolved > 0

## Phase 2: Classification

1. Call \`pr_list\` with \`filter: { resolved: false }\`
2. Classify by priority:
   - **HIGH** (must fix): CRIT, MAJOR, security issues
   - **MEDIUM** (should fix): MINOR, type safety, error handling
   - **LOW** (nice to have): NITPICK, style, docs

## Phase 3: User Approval

Present categorized list to user:
- Show priorities with brief descriptions
- Ask user to confirm which issues to address
- Allow user to skip or reprioritize items

## Phase 4: Implementation

For each approved item (HIGH → MEDIUM → LOW):
1. Call \`pr_get\` to fetch full details + AI prompt
2. **Execute AI prompt literally** if available
3. Read target file and apply fix
4. Verify fix compiles/passes lint
5. Call \`pr_resolve\` to mark thread resolved
6. Update todo list (mark completed)

## Phase 5: Completion

1. Re-check \`pr_summary\` - verify 0 unresolved
2. If new comments appeared, return to Phase 2
3. Report final status: "Ready for merge approval"
4. Summarize all fixes applied

## Rules

| Rule | Description |
|------|-------------|
| **NO DEFERRING** | Every comment gets fixed. No "complex = later" |
| **USE AI PROMPT** | Execute AI prompts from comments literally |
| **VERIFY FIXES** | Ensure each fix compiles before resolving |
| **ITERATE** | New review rounds may add more comments |

## Error Handling

If a tool fails:
- Retry with backoff for network errors
- Skip and note for permission errors
- Report blockers requiring manual intervention`;

// ============================================================================
// MCP Server
// ============================================================================

export class PRReviewMCPServer {
  private server: Server;
  private githubClient: GitHubClient;

  constructor() {
    this.server = new Server(
      {
        name: 'pr-review-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          prompts: {},
        },
      }
    );

    this.githubClient = new GitHubClient();
    this.setupToolHandlers();
    this.setupPromptHandlers();
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupPromptHandlers(): void {
    // List prompts
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      return {
        prompts: [
          {
            name: 'pr-review',
            description: 'Automated PR review processing - systematically address all review comments',
            arguments: [
              {
                name: 'owner',
                description: 'Repository owner (username or organization)',
                required: true
              },
              {
                name: 'repo',
                description: 'Repository name',
                required: true
              },
              {
                name: 'pr',
                description: 'Pull request number (as string)',
                required: true
              }
            ]
          }
        ] as Prompt[]
      };
    });

    // Get prompt
    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (name === 'pr-review') {
        const owner = args?.owner || '';
        const repo = args?.repo || '';
        const pr = args?.pr || '';

        const promptText = PR_REVIEW_PROMPT +
          (owner && repo && pr
            ? `\n\n---\n\nStarting review for **${owner}/${repo}#${pr}**. Let me get the summary first.`
            : '\n\n---\n\nPlease provide owner, repo, and pr number to begin.');

        return {
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: promptText
              }
            }
          ]
        };
      }

      throw new McpError(ErrorCode.MethodNotFound, `Unknown prompt: ${name}`);
    });
  }

  private setupToolHandlers(): void {
    // List tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'pr_summary',
            description: 'Get PR review statistics: total, resolved, unresolved counts by severity and file',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string', description: 'Repository owner' },
                repo: { type: 'string', description: 'Repository name' },
                pr: { type: 'number', description: 'Pull request number' }
              },
              required: ['owner', 'repo', 'pr']
            }
          },
          {
            name: 'pr_list',
            description: 'List PR review comments with optional filtering by resolved/file/severity',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string', description: 'Repository owner' },
                repo: { type: 'string', description: 'Repository name' },
                pr: { type: 'number', description: 'Pull request number' },
                filter: {
                  type: 'object',
                  properties: {
                    resolved: { type: 'boolean', description: 'Filter by resolved status' },
                    file: { type: 'string', description: 'Filter by file path (substring match)' }
                  }
                },
                max: { type: 'number', description: 'Max comments to return (default: 20)' }
              },
              required: ['owner', 'repo', 'pr']
            }
          },
          {
            name: 'pr_get',
            description: 'Get detailed comment information including full body and AI prompt',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string', description: 'Repository owner' },
                repo: { type: 'string', description: 'Repository name' },
                pr: { type: 'number', description: 'Pull request number' },
                id: { type: 'string', description: 'Comment or thread ID' }
              },
              required: ['owner', 'repo', 'pr', 'id']
            }
          },
          {
            name: 'pr_resolve',
            description: 'Mark a review thread as resolved',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string', description: 'Repository owner' },
                repo: { type: 'string', description: 'Repository name' },
                pr: { type: 'number', description: 'Pull request number' },
                threadId: { type: 'string', description: 'Thread ID to resolve' }
              },
              required: ['owner', 'repo', 'pr', 'threadId']
            }
          },
          {
            name: 'pr_changes',
            description: 'Get comments since cursor for incremental updates',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string', description: 'Repository owner' },
                repo: { type: 'string', description: 'Repository name' },
                pr: { type: 'number', description: 'Pull request number' },
                cursor: { type: 'string', description: 'Pagination cursor from previous call' },
                max: { type: 'number', description: 'Max comments to return (default: 50)' }
              },
              required: ['owner', 'repo', 'pr']
            }
          },
          {
            name: 'pr_invoke',
            description: 'Invoke AI code review agents on a PR',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string', description: 'Repository owner' },
                repo: { type: 'string', description: 'Repository name' },
                pr: { type: 'number', description: 'Pull request number' },
                agent: {
                  type: 'string',
                  enum: ['coderabbit', 'sourcery', 'qodo', 'gemini', 'codex', 'all'],
                  description: 'Agent to invoke, or "all" for configured agents from .github/pr-review.json'
                },
                options: {
                  type: 'object',
                  properties: {
                    focus: { type: 'string', description: 'Review focus: security, performance, best-practices' },
                    files: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Specific files to review'
                    },
                    incremental: { type: 'boolean', description: 'Review only new changes since last review' }
                  }
                }
              },
              required: ['owner', 'repo', 'pr', 'agent']
            }
          },
          {
            name: 'pr_poll_updates',
            description: 'Poll for new review updates since a timestamp (comments, commits, status)',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string', description: 'Repository owner' },
                repo: { type: 'string', description: 'Repository name' },
                pr: { type: 'number', description: 'Pull request number' },
                since: { type: 'string', description: 'ISO timestamp to poll from (omit for all)' },
                include: {
                  type: 'array',
                  items: { type: 'string', enum: ['comments', 'reviews', 'commits', 'status'] },
                  description: 'Update types to include (default: all)'
                }
              },
              required: ['owner', 'repo', 'pr']
            }
          },
          {
            name: 'pr_labels',
            description: 'Add, remove, or set labels on a PR',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string', description: 'Repository owner' },
                repo: { type: 'string', description: 'Repository name' },
                pr: { type: 'number', description: 'Pull request number' },
                action: { type: 'string', enum: ['add', 'remove', 'set'], description: 'Label action' },
                labels: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Label names'
                }
              },
              required: ['owner', 'repo', 'pr', 'action', 'labels']
            }
          },
          {
            name: 'pr_reviewers',
            description: 'Request or remove reviewers on a PR',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string', description: 'Repository owner' },
                repo: { type: 'string', description: 'Repository name' },
                pr: { type: 'number', description: 'Pull request number' },
                action: { type: 'string', enum: ['request', 'remove'], description: 'Reviewer action' },
                reviewers: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'GitHub usernames'
                },
                team_reviewers: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Team slugs'
                }
              },
              required: ['owner', 'repo', 'pr', 'action']
            }
          },
          {
            name: 'pr_create',
            description: 'Create a new pull request from an existing branch',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string', description: 'Repository owner' },
                repo: { type: 'string', description: 'Repository name' },
                title: { type: 'string', description: 'PR title' },
                body: { type: 'string', description: 'PR description' },
                base: { type: 'string', description: 'Base branch (default: main)' },
                head: { type: 'string', description: 'Head branch to merge from' },
                draft: { type: 'boolean', description: 'Create as draft PR' }
              },
              required: ['owner', 'repo', 'title', 'head']
            }
          },
          {
            name: 'pr_merge',
            description: 'Merge a pull request (CAUTION: destructive operation, requires confirm=true)',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string', description: 'Repository owner' },
                repo: { type: 'string', description: 'Repository name' },
                pr: { type: 'number', description: 'Pull request number' },
                method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge method (default: squash)' },
                commit_title: { type: 'string', description: 'Custom merge commit title' },
                commit_message: { type: 'string', description: 'Custom merge commit message' },
                delete_branch: { type: 'boolean', description: 'Delete head branch after merge (default: true)' },
                confirm: { type: 'boolean', const: true, description: 'REQUIRED: Must be true to confirm merge (safety guard)' }
              },
              required: ['owner', 'repo', 'pr', 'confirm']
            }
          }
        ] as Tool[]
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'pr_summary': {
            const input = SummaryInputSchema.parse(args);
            const result = await prSummary(input, this.githubClient);
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          }

          case 'pr_list': {
            const input = ListInputSchema.parse(args);
            const result = await prList(input, this.githubClient);
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          }

          case 'pr_get': {
            const input = GetInputSchema.parse(args);
            const result = await prGet(input, this.githubClient);
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          }

          case 'pr_resolve': {
            const input = ResolveInputSchema.parse(args);
            const result = await prResolveWithContext(input, this.githubClient);
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          }

          case 'pr_changes': {
            const input = ChangesInputSchema.parse(args);
            const result = await prChanges(input, this.githubClient);
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          }

          case 'pr_invoke': {
            const input = InvokeInputSchema.parse(args);
            const result = await prInvoke(input);
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          }

          case 'pr_poll_updates': {
            const input = PollInputSchema.parse(args);
            const result = await prPollUpdates(input, this.githubClient);
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          }

          case 'pr_labels': {
            const input = LabelsInputSchema.parse(args);
            const result = await prLabels(input);
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          }

          case 'pr_reviewers': {
            const input = ReviewersInputSchema.parse(args);
            const result = await prReviewers(input);
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          }

          case 'pr_create': {
            const input = CreateInputSchema.parse(args);
            const result = await prCreate(input);
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          }

          case 'pr_merge': {
            const input = MergeInputSchema.parse(args);
            const result = await prMerge(input);
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          }

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error) {
        if (error instanceof ZodError) {
          throw new McpError(ErrorCode.InvalidRequest, `Validation error: ${error.message}`);
        }

        if (error instanceof McpError) {
          throw error;
        }

        if (error instanceof StructuredError) {
          throw new McpError(
            error.kind === 'not_found' ? ErrorCode.InvalidRequest : ErrorCode.InternalError,
            error.message
          );
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${errorMessage}`);
      }
    });
  }

  async run(): Promise<void> {
    // Check prerequisites - exit early if not met
    try {
      this.githubClient.checkPrerequisites();
      console.error('✅ GitHub token configured');
    } catch (e) {
      if (e instanceof StructuredError) {
        console.error(`❌ ${e.message}`);
        if (e.userAction) {
          console.error(`   Action: ${e.userAction}`);
        }
      } else {
        console.error(`❌ Prerequisite check failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      process.exit(1);
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('🚀 PR Review MCP server running on stdio');
  }
}
