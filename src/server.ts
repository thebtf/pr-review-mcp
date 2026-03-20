/**
 * PR Review MCP Server
 *
 * Provides tools for processing PR reviews with GraphQL-based GitHub integration.
 * Features: cursor pagination (zero comments missed), 4-layer AI prompt extraction,
 * circuit breaker, and automated workflow prompt.
 *
 * Uses McpServer high-level API (SDK 1.25+) for declarative tool/prompt/resource registration.
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { GitHubClient, StructuredError } from './github/client.js';
import { logger } from './logging.js';
import { toMcpError } from './tools/shared.js';

// Tool handlers and schemas
import { prSummary, SummaryInputSchema, SummaryOutputSchema } from './tools/summary.js';
import { prList, ListInputSchema, ListOutputSchema } from './tools/list.js';
import { prGet, GetInputSchema, GetOutputSchema } from './tools/get.js';
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
  ProgressCheckSchema,
  WorkStatusOutputSchema,
  ProgressCheckOutputSchema,
} from './tools/coordination.js';

// Prompts
import {
  generateReviewPrompt,
  generateBackgroundReviewPrompt,
  REVIEW_PROMPT_DEFINITION,
  BACKGROUND_REVIEW_PROMPT_DEFINITION,
  type ReviewPromptArgs,
} from './prompts/review.js';
import {
  generateSetupPrompt,
  SETUP_PROMPT_DEFINITION,
  type SetupPromptArgs,
} from './prompts/setup.js';

// Resources
import { readPRResource } from './resources/pr.js';

// Read version from package.json (fix F10: version mismatch)
const require = createRequire(import.meta.url);
const pkg = require('../package.json');

// ============================================================================
// MCP Server
// ============================================================================

export class PRReviewMCPServer {
  private mcpServer: McpServer;
  private githubClient: GitHubClient;
  private httpServer?: import('node:http').Server;

  constructor() {
    this.mcpServer = new McpServer(
      { name: 'pr', version: pkg.version },
      {
        capabilities: {
          tools: {},
          prompts: {},
          logging: {},
          resources: {},
          experimental: { 'x-mux': { sharing: 'shared', stateless: false } },
        },
      },
    );

    this.githubClient = new GitHubClient();
    logger.initialize(this.mcpServer.server);

    this.registerTools();
    this.registerPrompts();
    this.registerResources();
    this.setupErrorHandling();
  }

  // --------------------------------------------------------------------------
  // Error handling
  // --------------------------------------------------------------------------

  private setupErrorHandling(): void {
    this.mcpServer.server.onerror = (error) => {
      logger.error('MCP protocol error', error);
    };

    process.on('SIGINT', async () => {
      if (this.httpServer) {
        this.httpServer.close();
      }
      await this.mcpServer.close();
      process.exit(0);
    });
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /** Wrap tool result as MCP text content */
  private static textResult(data: unknown): CallToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  /** Wrap tool result with both text content and structuredContent for outputSchema tools */
  private static structuredResult(data: object): CallToolResult {
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      structuredContent: data as Record<string, unknown>,
    };
  }

  // --------------------------------------------------------------------------
  // Tool registration
  // --------------------------------------------------------------------------

  private registerTools(): void {
    const client = this.githubClient;

    // -- Read-only query tools ------------------------------------------------

    this.mcpServer.registerTool('pr_summary', {
      title: 'Get PR Review Statistics',
      description: 'Get PR review statistics: total, resolved, unresolved counts by severity and file',
      inputSchema: SummaryInputSchema,
      outputSchema: SummaryOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (args) => {
      try { return PRReviewMCPServer.structuredResult(await prSummary(args, client)); }
      catch (e) { throw toMcpError(e); }
    });

    this.mcpServer.registerTool('pr_list_prs', {
      title: 'List Pull Requests',
      description: 'List all pull requests in a repository with stats (review threads, comments, changes)',
      inputSchema: ListPRsInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (args) => {
      try { return PRReviewMCPServer.textResult(await prListPRs(args, client)); }
      catch (e) { throw toMcpError(e); }
    });

    this.mcpServer.registerTool('pr_list', {
      title: 'List PR Review Comments',
      description: 'List PR review comments with optional filtering by resolved/file/severity',
      inputSchema: ListInputSchema,
      outputSchema: ListOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (args) => {
      try { return PRReviewMCPServer.structuredResult(await prList(args, client)); }
      catch (e) { throw toMcpError(e); }
    });

    this.mcpServer.registerTool('pr_get', {
      title: 'Get Detailed Comment Information',
      description: 'Get detailed comment information including full body and AI prompt',
      inputSchema: GetInputSchema,
      outputSchema: GetOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (args) => {
      try { return PRReviewMCPServer.structuredResult(await prGet(args, client)); }
      catch (e) { throw toMcpError(e); }
    });

    this.mcpServer.registerTool('pr_changes', {
      title: 'Get Incremental Comment Updates',
      description: 'Get comments since cursor for incremental updates',
      inputSchema: ChangesInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (args) => {
      try { return PRReviewMCPServer.textResult(await prChanges(args, client)); }
      catch (e) { throw toMcpError(e); }
    });

    this.mcpServer.registerTool('pr_poll_updates', {
      title: 'Poll for Review Updates',
      description: 'Poll for new review updates since a timestamp (comments, commits, status)',
      inputSchema: PollInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (args) => {
      try { return PRReviewMCPServer.textResult(await prPollUpdates(args, client)); }
      catch (e) { throw toMcpError(e); }
    });

    // -- Mutating tools -------------------------------------------------------

    this.mcpServer.registerTool('pr_resolve', {
      title: 'Resolve Review Thread',
      description: 'Mark a review thread as resolved',
      inputSchema: ResolveInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (args) => {
      try { return PRReviewMCPServer.textResult(await prResolveWithContext(args, client)); }
      catch (e) { throw toMcpError(e); }
    });

    this.mcpServer.registerTool('pr_invoke', {
      title: 'Invoke AI Code Review Agents',
      description: 'Invoke AI code review agents on a PR. When agent="all", agents are resolved from: (1) .github/pr-review.json in repo, (2) PR_REVIEW_AGENTS env var, (3) default (coderabbit only). Use pr:setup prompt to configure per-repo agents. Smart detection skips agents that already reviewed (use force to override).',
      inputSchema: InvokeInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async (args) => {
      try { return PRReviewMCPServer.textResult(await prInvoke(args)); }
      catch (e) { throw toMcpError(e); }
    });

    this.mcpServer.registerTool('pr_labels', {
      title: 'Manage PR Labels',
      description: 'Get, add, remove, or set labels on a PR',
      inputSchema: LabelsInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (args) => {
      try { return PRReviewMCPServer.textResult(await prLabels(args)); }
      catch (e) { throw toMcpError(e); }
    });

    this.mcpServer.registerTool('pr_reviewers', {
      title: 'Manage PR Reviewers',
      description: 'Request or remove reviewers on a PR',
      inputSchema: ReviewersInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (args) => {
      try { return PRReviewMCPServer.textResult(await prReviewers(args)); }
      catch (e) { throw toMcpError(e); }
    });

    this.mcpServer.registerTool('pr_create', {
      title: 'Create Pull Request',
      description: 'Create a new pull request from an existing branch',
      inputSchema: CreateInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async (args) => {
      try { return PRReviewMCPServer.textResult(await prCreate(args)); }
      catch (e) { throw toMcpError(e); }
    });

    this.mcpServer.registerTool('pr_merge', {
      title: 'Merge Pull Request',
      description: 'Merge a pull request (CAUTION: destructive operation, requires confirm=true)',
      inputSchema: MergeInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async (args) => {
      try { return PRReviewMCPServer.textResult(await prMerge(args)); }
      catch (e) { throw toMcpError(e); }
    });

    // -- Coordination tools ---------------------------------------------------

    this.mcpServer.registerTool('pr_claim_work', {
      title: 'Claim Work Partition',
      description: 'Claim file partition for parallel PR review processing',
      inputSchema: ClaimWorkSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async (args) => {
      try { return PRReviewMCPServer.textResult(await prClaimWork(args, client)); }
      catch (e) { throw toMcpError(e); }
    });

    this.mcpServer.registerTool('pr_report_progress', {
      title: 'Report Work Progress',
      description: 'Report completion status for a claimed file partition',
      inputSchema: ReportProgressSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async (args) => {
      try { return PRReviewMCPServer.textResult(await prReportProgress(args)); }
      catch (e) { throw toMcpError(e); }
    });

    this.mcpServer.registerTool('pr_get_work_status', {
      title: 'Get Work Status',
      description: 'Get current coordination run status and progress',
      inputSchema: GetWorkStatusSchema,
      outputSchema: WorkStatusOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (args) => {
      try { return PRReviewMCPServer.structuredResult(await prGetWorkStatus(args, client)); }
      catch (e) { throw toMcpError(e); }
    });

    this.mcpServer.registerTool('pr_reset_coordination', {
      title: 'Reset Coordination State',
      description: 'Reset/clear the current coordination run (use with caution)',
      inputSchema: ResetCoordinationSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }, async (args) => {
      try { return PRReviewMCPServer.textResult(await prResetCoordination(args)); }
      catch (e) { throw toMcpError(e); }
    });

    this.mcpServer.registerTool('pr_progress_update', {
      title: 'Report Orchestrator Phase',
      description: 'Report orchestrator phase transition (called by background subagent)',
      inputSchema: ProgressUpdateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async (args) => {
      try { return PRReviewMCPServer.textResult(await prProgressUpdate(args)); }
      catch (e) { throw toMcpError(e); }
    });

    this.mcpServer.registerTool('pr_progress_check', {
      title: 'Check Orchestrator Progress',
      description: 'Check orchestrator progress and run status in a single call',
      inputSchema: ProgressCheckSchema,
      outputSchema: ProgressCheckOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (args) => {
      try { return PRReviewMCPServer.structuredResult(await prProgressCheck(args)); }
      catch (e) { throw toMcpError(e); }
    });
  }

  // --------------------------------------------------------------------------
  // Prompt registration
  // --------------------------------------------------------------------------

  private registerPrompts(): void {
    const client = this.githubClient;

    // Shared Zod shape for review prompt arguments
    const reviewArgsSchema = {
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
      pr: z.string().optional().describe('PR number, GitHub URL, or short format (owner/repo#123)'),
      workers: z.string().optional().describe('Number of parallel workers (default: 3)'),
    };

    const makeReviewCallback = (generator: typeof generateReviewPrompt) => {
      return async (args: ReviewPromptArgs) => ({
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: await generator(args, client) } }],
      });
    };

    this.mcpServer.registerPrompt('review', {
      title: REVIEW_PROMPT_DEFINITION.title,
      description: REVIEW_PROMPT_DEFINITION.description,
      argsSchema: reviewArgsSchema,
    }, makeReviewCallback(generateReviewPrompt));

    this.mcpServer.registerPrompt('review-background', {
      title: BACKGROUND_REVIEW_PROMPT_DEFINITION.title,
      description: BACKGROUND_REVIEW_PROMPT_DEFINITION.description,
      argsSchema: reviewArgsSchema,
    }, makeReviewCallback(generateBackgroundReviewPrompt));

    this.mcpServer.registerPrompt('setup', {
      title: SETUP_PROMPT_DEFINITION.title,
      description: SETUP_PROMPT_DEFINITION.description,
      argsSchema: {
        repo: z.string().optional().describe('Repository in owner/repo format'),
      },
    }, async (args: SetupPromptArgs) => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: await generateSetupPrompt(args) } }],
    }));
  }

  // --------------------------------------------------------------------------
  // Resource registration
  // --------------------------------------------------------------------------

  private registerResources(): void {
    const client = this.githubClient;

    const template = new ResourceTemplate('pr://{owner}/{repo}/{pr}', { list: undefined });

    this.mcpServer.registerResource('pr', template, {
      description: 'Dynamic PR resource with summary and metadata. Use pr://{owner}/{repo}/{pr} format.',
      mimeType: 'application/json',
    }, async (uri, variables) => {
      return await readPRResource(uri.href, client);
    });
  }

  // --------------------------------------------------------------------------
  // Server lifecycle
  // --------------------------------------------------------------------------

  async run(options: { mode?: 'stdio' | 'http'; port?: number } = {}): Promise<void> {
    const { mode = 'stdio', port = 3000 } = options;

    // Check prerequisites — exit early if not met
    try {
      this.githubClient.checkPrerequisites();
      console.error('GitHub token configured');
    } catch (e) {
      if (e instanceof StructuredError) {
        console.error(`${e.message}`);
        if (e.userAction) {
          console.error(`   Action: ${e.userAction}`);
        }
      } else {
        console.error(`Prerequisite check failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      process.exit(1);
    }

    if (mode === 'http') {
      await this.runHttp(port);
    } else {
      const transport = new StdioServerTransport();
      await this.mcpServer.connect(transport);
      console.error('PR Review MCP server running on stdio');
    }
  }

  private async runHttp(port: number): Promise<void> {
    // Session map: each client session gets its own transport
    const sessions = new Map<string, StreamableHTTPServerTransport>();
    const sessionLastSeen = new Map<string, number>();
    const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

    // Periodic cleanup of stale sessions (disconnected without proper close)
    const cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [sid, lastSeen] of sessionLastSeen) {
        if (now - lastSeen > SESSION_TIMEOUT_MS) {
          const transport = sessions.get(sid);
          if (transport) transport.close();
          sessions.delete(sid);
          sessionLastSeen.delete(sid);
        }
      }
    }, 60_000);
    cleanupInterval.unref(); // Don't prevent process exit

    this.httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = req.url ?? '/';

        if (url === '/mcp' || url === '/') {
          const sessionId = req.headers['mcp-session-id'] as string | undefined;

          if (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE') {
            let transport: StreamableHTTPServerTransport;

            if (sessionId && sessions.has(sessionId)) {
              transport = sessions.get(sessionId)!;
              sessionLastSeen.set(sessionId, Date.now());
            } else {
              // New session — create transport and connect to McpServer
              transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
              });

              transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid) {
                  sessions.delete(sid);
                  sessionLastSeen.delete(sid);
                }
              };

              await this.mcpServer.connect(transport);

              if (transport.sessionId) {
                sessions.set(transport.sessionId, transport);
                sessionLastSeen.set(transport.sessionId, Date.now());
              }
            }

            await transport.handleRequest(req, res);
          } else {
            res.writeHead(405, { 'Content-Type': 'text/plain' });
            res.end('Method Not Allowed');
          }
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        }
      } catch (error) {
        logger.error('HTTP request handler error', error);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      }
    });

    this.httpServer.listen(port, () => {
      console.error(`PR Review MCP server running on http://localhost:${port}/mcp`);
    });
  }
}
