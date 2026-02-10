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
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  McpError,
  Tool,
  Prompt,
  Resource,
} from '@modelcontextprotocol/sdk/types.js';

import { z, ZodError } from 'zod';
import { GitHubClient, StructuredError } from './github/client.js';
import { logger } from './logging.js';
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
import { prListPRs, ListPRsInputSchema } from './tools/list-prs.js';
import {
  prClaimWork,
  prReportProgress,
  prGetWorkStatus,
  prResetCoordination,
  prProgressUpdate,
  prProgressCheck,
  ClaimWorkSchema,
  ReportProgressSchema,
  GetWorkStatusSchema,
  ResetCoordinationSchema,
  ProgressUpdateSchema,
  ProgressCheckSchema
} from './tools/coordination.js';
import { getInvokableAgentIds } from './agents/registry.js';
import {
  generateReviewPrompt,
  REVIEW_PROMPT_DEFINITION,
  type ReviewPromptArgs
} from './prompts/review.js';
import {
  generateSetupPrompt,
  SETUP_PROMPT_DEFINITION,
  type SetupPromptArgs
} from './prompts/setup.js';
import { listPRResources, readPRResource } from './resources/pr.js';

// ============================================================================
// MCP Server
// ============================================================================

export class PRReviewMCPServer {
  private server: Server;
  private githubClient: GitHubClient;

  constructor() {
    this.server = new Server(
      {
        name: 'pr',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          prompts: {},
          logging: {},
          resources: {},
        },
      }
    );

    this.githubClient = new GitHubClient();
    logger.initialize(this.server);
    this.setupToolHandlers();
    this.setupPromptHandlers();
    this.setupResourceHandlers();
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      logger.error('MCP protocol error', error);
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
            name: REVIEW_PROMPT_DEFINITION.name,
            description: REVIEW_PROMPT_DEFINITION.description,
            arguments: REVIEW_PROMPT_DEFINITION.arguments
          },
          {
            name: SETUP_PROMPT_DEFINITION.name,
            description: SETUP_PROMPT_DEFINITION.description,
            arguments: SETUP_PROMPT_DEFINITION.arguments
          }
        ] as Prompt[]
      };
    });

    // Get prompt
    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (name === 'review') {
        const promptArgs: ReviewPromptArgs = {
          owner: args?.owner as string | undefined,
          repo: args?.repo as string | undefined,
          pr: args?.pr as string | undefined,
          workers: args?.workers as string | undefined
        };

        const promptText = await generateReviewPrompt(promptArgs, this.githubClient);

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

      if (name === 'setup') {
        const setupArgs: SetupPromptArgs = {
          repo: args?.repo as string | undefined
        };

        const promptText = await generateSetupPrompt(setupArgs);

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

  private setupResourceHandlers(): void {
    // List resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources = await listPRResources();
      return { resources };
    });

    // Read resource
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      return await readPRResource(uri, this.githubClient);
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
            },
            annotations: {
              title: 'Get PR Review Statistics',
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: true
            }
          },
          {
            name: 'pr_list_prs',
            description: 'List all pull requests in a repository with stats (review threads, comments, changes)',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string', description: 'Repository owner' },
                repo: { type: 'string', description: 'Repository name' },
                state: { type: 'string', enum: ['OPEN', 'CLOSED', 'MERGED', 'all'], description: 'PR state filter (default: OPEN)' },
                limit: { type: 'number', description: 'Max PRs to return (default: 20, max: 100)' }
              },
              required: ['owner', 'repo']
            },
            annotations: {
              title: 'List Pull Requests',
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: true
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
            },
            annotations: {
              title: 'List PR Review Comments',
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: true
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
            },
            annotations: {
              title: 'Get Detailed Comment Information',
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: true
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
            },
            annotations: {
              title: 'Resolve Review Thread',
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: true
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
            },
            annotations: {
              title: 'Get Incremental Comment Updates',
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: true
            }
          },
          {
            name: 'pr_invoke',
            description: `Invoke AI code review agents on a PR. When agent="all", agents are resolved from: (1) .github/pr-review.json in repo, (2) PR_REVIEW_AGENTS env var, (3) default (coderabbit only). Use pr:setup prompt to configure per-repo agents. Smart detection skips agents that already reviewed (use force to override).`,
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string', description: 'Repository owner' },
                repo: { type: 'string', description: 'Repository name' },
                pr: { type: 'number', description: 'Pull request number' },
                agent: {
                  type: 'string',
                  enum: [...getInvokableAgentIds(), 'all'],
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
            },
            annotations: {
              title: 'Invoke AI Code Review Agents',
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: false,
              openWorldHint: true
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
                  items: { type: 'string', enum: ['comments', 'reviews', 'commits', 'status', 'agents'] },
                  description: 'Update types to include (default: all except agents). Use "agents" to get AI reviewer completion status.'
                },
                compact: {
                  type: 'boolean',
                  description: 'Return comment summary instead of full list (default: true)',
                  default: true
                }
              },
              required: ['owner', 'repo', 'pr']
            },
            annotations: {
              title: 'Poll for Review Updates',
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: true
            }
          },
          {
            name: 'pr_labels',
            description: 'Get, add, remove, or set labels on a PR',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string', description: 'Repository owner' },
                repo: { type: 'string', description: 'Repository name' },
                pr: { type: 'number', description: 'Pull request number' },
                action: { type: 'string', enum: ['get', 'add', 'remove', 'set'], description: 'Label action (get returns current labels)' },
                labels: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Label names (required for add/remove/set, ignored for get)'
                }
              },
              required: ['owner', 'repo', 'pr', 'action']
            },
            annotations: {
              title: 'Manage PR Labels',
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: true
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
                  description: 'GitHub usernames to request/remove as reviewers (at least one of reviewers or team_reviewers required)'
                },
                team_reviewers: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Team slugs to request/remove as reviewers (at least one of reviewers or team_reviewers required)'
                }
              },
              required: ['owner', 'repo', 'pr', 'action']
            },
            annotations: {
              title: 'Manage PR Reviewers',
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: true
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
            },
            annotations: {
              title: 'Create Pull Request',
              readOnlyHint: false,
              destructiveHint: true,
              idempotentHint: false,
              openWorldHint: true
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
            },
            annotations: {
              title: 'Merge Pull Request',
              readOnlyHint: false,
              destructiveHint: true,
              idempotentHint: false,
              openWorldHint: true
            }
          },
          {
            name: 'pr_claim_work',
            description: 'Claim file partition for parallel PR review processing',
            inputSchema: {
              type: 'object',
              properties: {
                agent_id: { type: 'string', description: 'Unique identifier for the claiming agent' },
                run_id: { type: 'string', description: 'Optional run ID (auto-created if not provided)' },
                pr_info: {
                  type: 'object',
                  properties: {
                    owner: { type: 'string', description: 'Repository owner' },
                    repo: { type: 'string', description: 'Repository name' },
                    pr: { type: 'number', description: 'Pull request number' }
                  },
                  required: ['owner', 'repo', 'pr'],
                  description: 'PR info (required if no active run)'
                },
                force: { type: 'boolean', description: 'Force replace active run (use with caution)' }
              },
              required: ['agent_id']
            },
            annotations: {
              title: 'Claim Work Partition',
              readOnlyHint: false,
              destructiveHint: true, // force=true can destroy existing run state
              idempotentHint: false,
              openWorldHint: false
            }
          },
          {
            name: 'pr_report_progress',
            description: 'Report completion status for a claimed file partition',
            inputSchema: {
              type: 'object',
              properties: {
                agent_id: { type: 'string', description: 'Agent ID that claimed the partition' },
                file: { type: 'string', description: 'File path being reported on' },
                status: { type: 'string', enum: ['done', 'failed', 'skipped'], description: 'Completion status' },
                result: {
                  type: 'object',
                  properties: {
                    commentsProcessed: { type: 'number', description: 'Number of comments processed' },
                    commentsResolved: { type: 'number', description: 'Number of comments resolved' },
                    errors: { type: 'array', items: { type: 'string' }, description: 'Any errors encountered' }
                  }
                }
              },
              required: ['agent_id', 'file', 'status']
            },
            annotations: {
              title: 'Report Work Progress',
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: false,
              openWorldHint: false
            }
          },
          {
            name: 'pr_get_work_status',
            description: 'Get current coordination run status and progress',
            inputSchema: {
              type: 'object',
              properties: {
                run_id: { type: 'string', description: 'Optional run ID (defaults to current run)' }
              }
            },
            annotations: {
              title: 'Get Work Status',
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false
            }
          },
          {
            name: 'pr_reset_coordination',
            description: 'Reset/clear the current coordination run (use with caution)',
            inputSchema: {
              type: 'object',
              properties: {
                confirm: { type: 'boolean', const: true, description: 'Must be true to confirm reset (safety guard)' }
              },
              required: ['confirm']
            },
            annotations: {
              title: 'Reset Coordination State',
              readOnlyHint: false,
              destructiveHint: true,
              idempotentHint: true,
              openWorldHint: false
            }
          },
          {
            name: 'pr_progress_update',
            description: 'Report orchestrator phase transition (called by background subagent)',
            inputSchema: {
              type: 'object',
              properties: {
                phase: {
                  type: 'string',
                  enum: ['escape_check', 'preflight', 'label', 'invoke_agents', 'poll_wait', 'spawn_workers', 'monitor', 'build_test', 'complete', 'error', 'aborted'],
                  description: 'Current orchestrator phase'
                },
                detail: { type: 'string', description: 'Optional context (max 200 chars)', maxLength: 200 }
              },
              required: ['phase']
            },
            annotations: {
              title: 'Report Orchestrator Phase',
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: false,
              openWorldHint: false
            }
          },
          {
            name: 'pr_progress_check',
            description: 'Check orchestrator progress and run status in a single call',
            inputSchema: {
              type: 'object',
              properties: {}
            },
            annotations: {
              title: 'Check Orchestrator Progress',
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false
            }
          }
        ] as Tool[]
      };
    });

    // Type definition for tool handlers
    type ToolHandler = (args: any, client?: GitHubClient) => Promise<any>;

    // Helper to create tool handler with schema validation and unified error handling
    const createToolHandler = <T extends z.ZodTypeAny>(
      schema: T,
      handler: (input: z.infer<T>, client: GitHubClient) => Promise<any>
    ): ToolHandler => {
      return async (args, client) => {
        if (!client) {
          throw new Error('GitHubClient is required for this handler');
        }
        const validated = schema.parse(args);
        return handler(validated, client);
      };
    };

    // Helper for handlers that don't need client
    const createSimpleHandler = <T extends z.ZodTypeAny>(
      schema: T,
      handler: (input: z.infer<T>) => Promise<any>
    ): ToolHandler => {
      return async (args) => {
        const validated = schema.parse(args);
        return handler(validated);
      };
    };

    // Tool handler map for better maintainability and scalability
    const toolHandlers: Record<string, ToolHandler> = {
      'pr_summary': createToolHandler(SummaryInputSchema, prSummary),
      'pr_list_prs': createToolHandler(ListPRsInputSchema, prListPRs),
      'pr_list': createToolHandler(ListInputSchema, prList),
      'pr_get': createToolHandler(GetInputSchema, prGet),
      'pr_resolve': createToolHandler(ResolveInputSchema, prResolveWithContext),
      'pr_changes': createToolHandler(ChangesInputSchema, prChanges),
      'pr_invoke': createSimpleHandler(InvokeInputSchema, prInvoke),
      'pr_poll_updates': createToolHandler(PollInputSchema, prPollUpdates),
      'pr_labels': createSimpleHandler(LabelsInputSchema, prLabels),
      'pr_reviewers': createSimpleHandler(ReviewersInputSchema, prReviewers),
      'pr_create': createSimpleHandler(CreateInputSchema, prCreate),
      'pr_merge': createSimpleHandler(MergeInputSchema, prMerge),
      'pr_claim_work': createToolHandler(ClaimWorkSchema, prClaimWork),
      'pr_report_progress': createSimpleHandler(ReportProgressSchema, prReportProgress),
      'pr_get_work_status': createToolHandler(GetWorkStatusSchema, prGetWorkStatus),
      'pr_reset_coordination': createSimpleHandler(ResetCoordinationSchema, prResetCoordination),
      'pr_progress_update': createSimpleHandler(ProgressUpdateSchema, prProgressUpdate),
      'pr_progress_check': createSimpleHandler(ProgressCheckSchema, prProgressCheck)
    };

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        const handler = toolHandlers[name];
        if (!handler) {
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }

        const result = await handler(args, this.githubClient);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        if (error instanceof ZodError) {
          throw new McpError(ErrorCode.InvalidRequest, `Validation error: ${error.message}`);
        }

        if (error instanceof McpError) {
          throw error;
        }

        if (error instanceof StructuredError) {
          const errorCodeMap: Record<string, ErrorCode> = {
            'auth': ErrorCode.InvalidRequest,
            'permission': ErrorCode.InvalidRequest,
            'not_found': ErrorCode.InvalidRequest,
            'parse': ErrorCode.InvalidRequest,
            'rate_limit': ErrorCode.InternalError,
            'network': ErrorCode.InternalError,
            'circuit_open': ErrorCode.InternalError
          };
          throw new McpError(
            errorCodeMap[error.kind] ?? ErrorCode.InternalError,
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
