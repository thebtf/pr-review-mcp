# Continuity — PR Review MCP Server

## Current State (2026-01-09)

### Branch: `feat/pr-review-mcp-server`

### What's Done

1. **Core MCP Server** — 6 tools working:
   - `pr_summary` — statistics with multi-source support
   - `pr_list` — filtering by resolved/file/source
   - `pr_get` — full comment details + AI prompt
   - `pr_resolve` — mark threads resolved
   - `pr_changes` — cursor pagination
   - `pr_invoke` — invoke agents (CodeRabbit, Sourcery, Qodo)

2. **Multi-Source Detection** — 6 agents:
   - CodeRabbit, Gemini, Copilot, Sourcery, Codex → inline review threads
   - Qodo → persistent issue comment (adapter created)

3. **Agent Invocation** — `pr_invoke` tool:
   - Posts `@mention` or `/slash` commands via `gh pr comment`
   - Windows MSYS workaround for slash commands
   - Repo config support (`.github/pr-review.json`)

4. **Qodo Adapter** — `src/adapters/qodo.ts`:
   - Fetches Qodo's persistent issue comment
   - Parses security concerns → CRIT severity
   - Parses focus areas → MAJOR severity
   - Integrated into `pr_list` and `pr_summary`

### What's In Progress

**Qodo Integration Testing:**
- Adapter code written but NOT tested via MCP protocol
- Need to run `mcp-test.mjs` to verify Qodo comments appear
- Build passes (`npm run build`)

### Test PR

`thebtf/pr-review-mcp#2` — 72+ comments from 6 agents:
- CodeRabbit: 22
- Copilot: 25
- Gemini: 14
- Sourcery: 9
- Codex: 2
- Qodo: 4 (1 security + 3 focus areas) — **needs verification**

---

## Next Steps

1. **Test Qodo Integration**
   ```bash
   node mcp-test.mjs
   ```
   Should show Qodo comments in `pr_list` and `pr_summary`

2. **Fix Qodo File Paths**
   - Currently stores GitHub diff URL instead of file path
   - Need to extract file name from code snippets or surrounding context

3. **Commit Changes**
   - New files: `src/adapters/qodo.ts`
   - Modified: `src/tools/list.ts`, `src/tools/summary.ts`, `src/github/types.ts`

4. **Update PR #2** — push changes, re-run stress test

---

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Parallel fetching | `Promise.all([threads, qodo])` — minimize latency |
| Qodo as adapter | Isolate complexity, different data source pattern |
| Newline-delimited JSON | MCP SDK uses this, NOT Content-Length framing |
| Fire-and-forget invoke | No polling for agent responses |

---

## Files Changed Since Last Commit

```
src/adapters/qodo.ts          # NEW - Qodo adapter
src/tools/list.ts             # Modified - Qodo integration
src/tools/summary.ts          # Modified - Qodo integration  
src/github/types.ts           # Modified - added 'qodo' to CommentSource
src/server.ts                 # Modified - prompt argument description
.agent/                       # NEW - agent infrastructure
CLAUDE.md                     # NEW
AGENTS.md                     # NEW
.gitignore                    # Modified
```

---

## Debugging Notes

- **MCP Protocol**: Use `spawn('node', ['dist/index.js'])` + newline JSON
- **Qodo Detection**: Look for `qodo-code-review[bot]` in issue comments
- **Qodo Marker**: `## PR Reviewer Guide 🔍`
- **Windows**: `MSYS_NO_PATHCONV=1` for `/review` command
