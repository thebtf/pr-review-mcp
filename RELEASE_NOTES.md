# Release Notes — v0.6.0

## Highlights

### Plugin-first packaging
`pr-review-mcp` now ships as a more complete Claude Code plugin package rather than only an MCP server. The repo now includes:
- built-in `pr-reviewer` background agent
- canonical `pr-review` skill
- prompt/command wrappers for `/pr:review`, `/pr:review-background`, and `/pr:setup`
- package metadata that actually includes the shipped plugin artifacts

### SQLite persistence
Review state no longer has to live entirely in memory.
- `pr_invoke` state can be persisted to SQLite
- agent status can be recovered across sessions
- worker coordination can survive server restarts
- `pr_sessions` provides visibility into active and recent review invocations

### Non-blocking review waiting
`pr_await_reviews` no longer freezes the client session waiting for long-running reviewers. It now checks once and returns immediately with a `retryAfterMs` hint, allowing polling-based orchestration.

## Included since v0.4.1

### v0.5.0
- unified reviewer completion detection
- per-agent completion strategies and better false-positive filtering
- corrected handling for CodeRabbit, Gemini, Qodo, Greptile, and others
- stricter PR review rules: process all severities, confidence-check every suggestion

### v0.6.0
- SQLite persistence layer (`src/persistence/*`)
- SQLite-backed coordination state (`src/coordination/sqlite-state.ts`)
- `pr_sessions` tool
- built-in `agents/pr-reviewer.md`
- canonical `skills/pr-review/SKILL.md`
- `commands/review-background.md`
- local debug `.mcp.json` restored to `node dist/index.js`
- `/pr:review` no-argument submission restored

## Upgrade Notes

### If you use the plugin package
- keep `.claude-plugin/plugin.json` with `${CLAUDE_PLUGIN_ROOT}/dist/index.js`
- consume the built-in `pr-reviewer` and `pr-review` artifacts instead of rebuilding wrappers downstream

### If you debug inside this repository
- use the project-level `.mcp.json` with `node dist/index.js`
- this is intentionally different from the plugin package launch path

### Review workflow guidance
- `/pr:review` is an MCP prompt / slash command
- `pr-review` is the canonical consumer skill
- `pr-reviewer` is the built-in background executor
- `Skill("mcp__pr__review")` is the wrong abstraction

## Validation

- Build: PASS
- Tests: 227/227 PASS
- PRs shipped in this release line: #25, #26, #27, #28, #29
