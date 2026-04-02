# AGENTS.md — PR Review MCP Server

## PURPOSE

MCP server for orchestrating AI-driven PR reviews with 7 agent sources, 19 tools, and parallel multi-agent coordination.

**Features:**
- GraphQL-based GitHub integration with cursor pagination
- Multi-source comment detection and severity extraction
- AI prompt extraction from review comments
- Agent invocation + server-side review await (`pr_invoke` → `pr_await_reviews`)
- Parallel worker orchestration for comment processing

---

## LANGUAGE

- **Communication with user:** RUSSIAN
- **Code, commits, docs:** ENGLISH

---

## PROJECT STRUCTURE

```
pr-review-mcp/
├── src/
│   ├── server.ts              # MCP server entry point
│   ├── logging.ts             # MCP logging utility
│   ├── index.ts               # CLI entry point
│   ├── session/
│   │   ├── types.ts           # MuxMeta, MuxSessionContext interfaces
│   │   ├── meta.ts            # extractMuxMeta() from extra._meta
│   │   ├── context.ts         # createSessionContext() factory
│   │   └── manager.ts         # MuxSessionManager (per-session state)
│   ├── github/
│   │   ├── client.ts          # GitHub GraphQL/REST client
│   │   ├── octokit.ts         # Octokit instance management
│   │   ├── queries.ts         # GraphQL queries
│   │   ├── types.ts           # TypeScript types
│   │   └── state-comment.ts   # State comment persistence
│   ├── git/
│   │   └── detect.ts          # Git repo/branch detection
│   ├── tools/
│   │   ├── summary.ts         # pr_summary
│   │   ├── list.ts            # pr_list
│   │   ├── list-prs.ts        # pr_list_prs
│   │   ├── get.ts             # pr_get
│   │   ├── changes.ts         # pr_changes
│   │   ├── poll.ts            # pr_poll_updates
│   │   ├── await-reviews.ts   # pr_await_reviews
│   │   ├── invoke.ts          # pr_invoke
│   │   ├── resolve.ts         # pr_resolve
│   │   ├── labels.ts          # pr_labels
│   │   ├── reviewers.ts       # pr_reviewers
│   │   ├── create.ts          # pr_create
│   │   ├── merge.ts           # pr_merge
│   │   ├── coordination.ts    # pr_claim_work, pr_report_progress, etc.
│   │   └── shared.ts          # Shared utilities
│   ├── monitors/
│   │   └── review-monitor.ts  # ReviewMonitor (server-side polling)
│   ├── adapters/
│   │   ├── qodo.ts            # Qodo issue comment adapter
│   │   └── greptile.ts        # Greptile issue comment adapter
│   ├── agents/
│   │   ├── registry.ts        # Agent configurations
│   │   ├── invoker.ts         # Agent invocation logic
│   │   ├── detector.ts        # Smart agent detection
│   │   └── status.ts          # Agent status detection (shared)
│   ├── extractors/
│   │   ├── severity.ts        # Severity extraction
│   │   ├── prompt.ts          # AI prompt extraction
│   │   ├── coderabbit-nitpicks.ts
│   │   └── multi-issue.ts     # Multi-issue splitting
│   ├── prompts/
│   │   ├── review.ts          # Review orchestrator prompt
│   │   └── setup.ts           # Setup wizard prompt
│   ├── resources/
│   │   └── pr.ts              # PR resource (pr://{owner}/{repo}/{pr})
│   └── coordination/
│       ├── state.ts           # Coordination state management
│       └── types.ts           # Coordination types
├── skills/
│   └── review/
│       └── SKILL.md           # PR review skill (Claude Code plugin)
├── commands/
│   ├── review.md              # Legacy review command
│   └── setup.md               # Setup command
└── dist/                      # Compiled output
```

---

## MCP TOOLS (19)

### Analysis

| Tool | Description |
|------|-------------|
| `pr_summary` | PR review statistics: total, resolved, unresolved, by severity/file |
| `pr_list_prs` | List open PRs in a repository with activity stats |
| `pr_list` | List review comments with filtering (resolved, file, source, severity) |
| `pr_get` | Full comment details including body and AI prompt |
| `pr_changes` | Incremental updates since cursor |
| `pr_poll_updates` | Poll for new comments, commits, check status, agent completion |
| `pr_await_reviews` | **Block server-side** until invoked agents post reviews (up to 10 min timeout). Use after `pr_invoke`. |

### Action

| Tool | Description |
|------|-------------|
| `pr_invoke` | Invoke AI review agents. Returns `since`, `invokedAgentIds`, `awaitHint` for handoff to `pr_await_reviews`. |
| `pr_resolve` | Resolve a review thread |
| `pr_labels` | Add, remove, or list labels |
| `pr_reviewers` | Request or remove reviewers |
| `pr_create` | Create a pull request |
| `pr_merge` | Merge a PR (with MCP elicitation confirmation) |

### Orchestration

| Tool | Description |
|------|-------------|
| `pr_claim_work` | Claim file partition for parallel comment processing |
| `pr_report_progress` | Report completion status for a claimed partition |
| `pr_get_work_status` | Full run status: partition counts, per-agent progress |
| `pr_reset_coordination` | Reset coordination state (with confirmation) |
| `pr_progress_update` | Report orchestrator phase transition |
| `pr_progress_check` | Read orchestrator phase history and run progress |

---

## TESTING

**MCP Protocol Testing** (NOT direct function calls):

```javascript
const server = spawn('node', ['dist/index.js']);
server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {...} }) + '\n');
```

**Test PR:** `thebtf/pr-review-mcp#2` (72+ comments from 6 agents)

---

## AGENT SOURCES

| Source | Type | Detection |
|--------|------|-----------|
| CodeRabbit | Inline reviews | `coderabbitai[bot]` |
| Gemini | Inline reviews | `gemini-code-assist[bot]` |
| Copilot | Inline reviews | `copilot-pull-request-reviewer[bot]` |
| Sourcery | Inline reviews | `sourcery-ai[bot]` |
| Codex | Inline reviews | `chatgpt-codex-connector[bot]` |
| **Qodo** | **Issue comment** | `qodo-code-review[bot]` |
| **Greptile** | **Issue comment + inline** | `greptile-code-reviews[bot]` |

Qodo uses a "persistent review" pattern — one issue comment updated on each commit.
Greptile posts an overview issue comment + inline review comments.

---

## SMART DETECTION

`pr_invoke` includes smart detection to avoid re-invoking agents that already reviewed:

- Detects agents that already submitted reviews (by author login)
- Skips agents that already reviewed → returns in `skipped` array
- Only CodeRabbit is invoked by default (configurable via `.github/pr-review.json`)

**Response includes:**
```json
{
  "invoked": ["CodeRabbit"],
  "skipped": ["Gemini", "Codex"],
  "failed": [],
  "since": "2026-03-28T10:00:00.000Z",
  "invokedAgentIds": ["coderabbit"],
  "awaitHint": "Call pr_await_reviews with since=... and agents=[...] to wait for reviews."
}
```

---

## SESSION-AWARE MODE (mcp-mux)

The server declares `x-mux: { sharing: "session-aware" }` for mcp-mux v0.6.0+.

**How it works:**
- mcp-mux injects `_meta.muxSessionId` + `_meta.muxEnv` into every JSON-RPC request
- `MuxSessionManager` creates per-session contexts (Octokit, GitHubClient, CoordinationState)
- Token resolved from: `muxEnv.GITHUB_PERSONAL_ACCESS_TOKEN` → `process.env` fallback
- Stale sessions cleaned up after 30 minutes of inactivity

**Per-session state:** Octokit, GraphQL client, GitHubClient (with CircuitBreaker), CoordinationStateManager
**Shared state:** ReviewMonitor (keyed by PR), MCP logger

**Stdio fallback:** Without mcp-mux, uses `"default"` session with `process.env` token.

---

## RULES

| Rule | Description |
|------|-------------|
| **Test via MCP** | Always test through MCP protocol, not direct imports |
| **No gh CLI in tests** | Use MCP tools, not raw `gh` commands |
| **PR ops via MCP only** | **CRITICAL:** All PR operations must go through MCP server, never direct `gh` CLI |
| **Parallel fetching** | Fetch review threads + Qodo in parallel |
| **Windows compat** | Use `MSYS_NO_PATHCONV=1` for slash commands |

---

## COMMANDS

```bash
# Build
npm run build

# Run server (stdio, default)
node dist/index.js

# Run server (HTTP, StreamableHTTP on port 3000)
node dist/index.js --http
node dist/index.js --http 8080

# Test with MCP Inspector
npx @modelcontextprotocol/inspector node dist/index.js
```
