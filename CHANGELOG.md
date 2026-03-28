# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-03-28

### Added

- **`pr_await_reviews` tool** — server-side blocking until all invoked AI review agents post reviews. Configurable timeout (default 10 min) and poll interval (default 30s). Progress reported via MCP logging notifications.
- **ReviewMonitor class** (`src/monitors/review-monitor.ts`) — encapsulates poll loop, timeout handling, concurrent call deduplication, exponential backoff on GitHub rate limits, and cleanup via AbortController.
- **`skills/review/SKILL.md`** — Claude Code plugin skill with rich frontmatter (`allowed-tools`, `argument-hint`). Single `/pr:review` command handles auto-detection, delegation, and background orchestration.
- **GitHub Actions CI** (`.github/workflows/ci.yml`) — build + test with coverage on Node 18, 20, 22.
- **Test coverage** — added `@vitest/coverage-v8` and `test:coverage` script. Baseline: 51.7% statements.
- **`fetchAgentStatusForAgents`** — shared agent status detection for specific agent subsets (used by ReviewMonitor).

### Changed

- **`pr_invoke` response** — now includes `since` (ISO timestamp, 1s buffer), `invokedAgentIds`, and `awaitHint` for seamless handoff to `pr_await_reviews`.
- **Orchestrator prompt Step 5** — uses `pr_await_reviews` as primary method with `pr_poll_updates` fallback.
- **`pr_poll_updates` description** — mentions `pr_await_reviews` as preferred alternative for agent waiting.
- **Qodo detection** — uses `updated_at` (not just `created_at`) for persistent issue comment tracking.
- **`fetchAgentStatus`** — now delegates to `fetchAgentStatusForAgents`, eliminating 80 lines of code duplication.

### Fixed

- Duplicate `pr_await_reviews` tool registration in server.ts (linter-generated).
- Dedup key for ReviewMonitor includes `since` + sorted agents (prevents cross-call interference).
- HTTP 403 classified as rate limit only when message contains "rate limit" / "abuse detection" / "secondary rate" (auth errors no longer masked).
- 10 dependency vulnerabilities resolved via `npm audit fix`.

## [0.2.1] - 2026-03-20

### Added

- **Claude Code plugin structure** — `.claude-plugin/plugin.json`, `.mcp.json`, `commands/review.md`, `commands/setup.md`.
- **Russian README** — `README.ru.md` with full translation and language switcher.
- Updated CHANGELOG with v0.1.5 and v0.2.0 entries.

### Removed

- Stale artifacts: `PAL_*.md`, `RESOURCES.md`, `test-pal-tools.js`.

## [0.2.0] - 2026-03-20

### Added

- **Greptile agent support** — parse issue comments + inline reviews from `greptile-code-reviews[bot]`
- **HTTP transport** — `--http [port]` flag for StreamableHTTP server with per-session management
- **MCP elicitation** — interactive confirmation for `pr_merge` and `pr_reset_coordination` via `elicitation/create`, with `confirm` param fallback for non-interactive clients
- **Structured output** — `outputSchema` + `structuredContent` for 5 tools: `pr_summary`, `pr_list`, `pr_get`, `pr_get_work_status`, `pr_progress_check`
- **Background review prompt** (`review-background`) — fire-and-forget autonomous PR review with self-managed TaskList
- **`pr_progress_update`** tool — report orchestrator phase transitions
- **`pr_progress_check`** tool — check orchestrator progress and run status
- **`getThread` GraphQL query** — single-thread fetch by node ID for optimized `pr_get`
- **`clearExpiredRuns()`** — auto-cleanup of abandoned coordination runs by inactivity (30min threshold)
- **`toMcpError()` helper** — unified error conversion for StructuredError/ZodError/McpError

### Changed

- **McpServer migration** — replaced low-level `Server` API with `McpServer` high-level API (`registerTool`/`registerPrompt`/`registerResource`). server.ts: 771 → 350 lines (-54%)
- **ResourceTemplate** — PR resource uses URI template parsing instead of manual regex
- **Version from package.json** — fixed hardcoded `1.0.0` in server capabilities
- **`confirm` parameter** now optional in `pr_merge` and `pr_reset_coordination` (elicitation replaces it)
- Greptile `authorPattern` corrected to `greptile-apps`
- Greptile adapter supports both HTML and Markdown headers
- `pr_get` tries `fetchSingleThread()` fast path for full node IDs before full fetch
- `pr_get` validates ambiguous suffix matches (throws instead of picking first)
- `pr_list` deduplicates Qodo/Greptile comment computation

### Fixed

- **mcp-mux correctness** — `x-mux.stateless: true` → `false` (server maintains in-memory coordination state)
- **SIGINT race condition** — consolidated duplicate handlers into single graceful shutdown
- **Node 18.x compatibility** — explicit `crypto` import for `randomUUID()`
- **JSON.parse crash** — `.github/pr-review.json` parsing wrapped in dedicated try-catch with warning log
- **Elicitation security** — validates `confirm === true` from elicited form content
- **Client capability check** — verifies `elicitation` capability before `sendRequest` (no catch-all masking)
- **HTTP error handling** — try/catch in async request handler prevents unhandled rejections
- **Session cleanup** — periodic 30-min timeout for stale HTTP sessions
- Confidence score validation (1-5 range) in Greptile adapter

## [0.1.5] - 2026-02-11

### Added

- Delegation hint in review prompt for autonomous worker spawning
- Task sweep fix for completed partition tracking

### Changed

- Simplified README installation instructions

## [0.1.4] - 2026-02-09

### Added

- **Branch protection guard** — refuse to process a different PR when on a feature branch with an open PR (prevents merge conflicts in worktree setups)
- `branchMismatch` detection in `buildContext()` with clear refusal message and recovery options
- `sameRepo` guard — branch protection only applies within the same repository (cross-repo is safe)
- `sanitizePromptValue()` for branch names in prompts (prompt injection defense)
- 8 unit tests for branch protection scenarios (mismatch/allow/bypass/fail-open)

### Changed

- `buildContext()` restructured: branch detection runs **before** explicit PR processing
- `prListPRs` result cached to avoid duplicate API call in multi-PR fallback

### Fixed

- Missing `src/git/detect.ts` module — was untracked since v0.1.3 (broke npm publish)

## [0.1.3] - 2026-02-09

### Added

- **Hybrid Task UI monitoring** — orchestrator creates Claude Code Tasks for file partitions and orchestrator steps, providing real-time progress visibility
- **Cross-repo Task subject format** `PR {owner}/{repo}#{pr}: {file}` for multi-repo clarity

### Fixed

- Workers cannot use TaskCreate/TaskUpdate/TaskList (platform limitation for background subagents) — orchestrator now owns all Task UI updates

### Security

- Sanitize GitHub file paths in Task subjects and worker prompts (prompt injection defense)

### Documentation

- Task-first coordination design plan
- Rejected structured output monitoring design

## [0.1.2] - 2026-02-08

### Fixed

- Deduplicate synthetic CodeRabbit nitpick comments (#12)

### Added

- Compact mode for `pr_poll_updates` (#11)
- `--version` / `-v` / `-V` flag to CLI

### CI

- Switch to OIDC trusted publishing for npm

## [0.1.1] - 2026-02-07

### Added

- **`pr_setup` MCP Prompt** — onboarding prompt for configuring `.github/pr-review.json`
  - Reads existing repo config via GitHub API
  - Shows available agents, env config, and configuration priority
  - Guides user through agent selection and config creation

### Improved

- `pr_invoke` tool description now lists available agents inline
- `pr_get_work_status` detects pending AI reviewers (`pendingAgents` field)
- PR review skill: MCP bootstrap step, two-phase re-review polling, `gh` CLI prohibition

### Fixed

- CI: added npm-publish environment and OIDC trusted publishing to GitHub Actions workflow

## [0.1.0] - 2026-01-13

### Added

- **15 MCP Tools** for complete PR review automation
  - `pr_summary` - PR statistics (total, resolved, by severity/file)
  - `pr_list` - List comments with filtering
  - `pr_list_prs` - List open PRs with activity stats
  - `pr_get` - Get comment details with AI prompt extraction
  - `pr_resolve` - Mark thread as resolved via GraphQL
  - `pr_changes` - Incremental updates with cursor pagination
  - `pr_invoke` - Invoke AI reviewers (CodeRabbit, Gemini, Codex, Sourcery, Qodo)
  - `pr_poll_updates` - Poll for new comments and agent status
  - `pr_labels` - Manage PR labels
  - `pr_reviewers` - Manage PR reviewers
  - `pr_create` - Create new PR
  - `pr_merge` - Merge PR with safety checks
  - `pr_claim_work` - Multi-agent work distribution
  - `pr_report_progress` - Worker progress reporting
  - `pr_get_work_status` - Orchestration status

- **Multi-Agent Support**
  - CodeRabbit (`coderabbitai[bot]`)
  - Gemini (`gemini-code-assist[bot]`)
  - Copilot (`copilot-pull-request-reviewer[bot]`)
  - Sourcery (`sourcery-ai[bot]`)
  - Qodo (`qodo-code-review[bot]`)
  - Codex (`chatgpt-codex-connector[bot]`)

- **Smart Parsing**
  - CodeRabbit nitpick extraction from review bodies
  - Multi-issue comment splitting
  - AI prompt extraction with confidence levels
  - Severity classification (CRIT/MAJOR/MINOR)

- **Multi-Agent Orchestration**
  - Parallel worker coordination
  - File-based work partitioning
  - Progress tracking and reporting
  - GitHub comment-based state persistence

- **MCP 2025-11-25 Compliance**
  - Resource support (`pr://` URIs)
  - Structured logging
  - Tool annotations (readOnlyHint, destructiveHint)

- **Resilience**
  - Circuit breaker pattern for API stability
  - Rate limit handling via @octokit plugins
  - Cursor-based pagination for large PRs

[0.2.0]: https://github.com/thebtf/pr-review-mcp/releases/tag/v0.2.0
[0.1.5]: https://github.com/thebtf/pr-review-mcp/releases/tag/v0.1.5
[0.1.4]: https://github.com/thebtf/pr-review-mcp/releases/tag/v0.1.4
[0.1.3]: https://github.com/thebtf/pr-review-mcp/releases/tag/v0.1.3
[0.1.2]: https://github.com/thebtf/pr-review-mcp/releases/tag/v0.1.2
[0.1.1]: https://github.com/thebtf/pr-review-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/thebtf/pr-review-mcp/releases/tag/v0.1.0
