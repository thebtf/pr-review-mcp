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

5. **Test Client** — `scripts/mcp-test-client.mjs`:
   - Interactive and quick-call modes
   - Correct MCP protocol (newline-delimited JSON)

### What's In Progress

**Qodo Integration Testing:**
- Adapter code written but NOT tested via MCP protocol
- Build passes (`npm run build`)

---

## Next Steps

1. **Test Qodo Integration**
   ```bash
   # Quick test
   node scripts/mcp-test-client.mjs pr_summary 2

   # Interactive
   node scripts/mcp-test-client.mjs
   mcp> summary 2
   mcp> list 2 false
   ```
   Should show Qodo comments in results

2. **Fix Qodo File Paths** (if needed)
   - Currently may store GitHub diff URL instead of file path
   - Need to extract file name from code snippets or surrounding context

3. **Test pr_invoke** on real agents

---

## Test PR

`thebtf/pr-review-mcp#2` — 72+ comments from 6 agents:
- CodeRabbit: 22
- Copilot: 25
- Gemini: 14
- Sourcery: 9
- Codex: 2
- Qodo: 4 (1 security + 3 focus areas) — **needs verification**

---

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Parallel fetching | `Promise.all([threads, qodo])` — minimize latency |
| Qodo as adapter | Isolate complexity, different data source pattern |
| Newline-delimited JSON | MCP SDK uses this, NOT Content-Length framing |
| Fire-and-forget invoke | No polling for agent responses |

---

## Test Client Usage

```bash
# Interactive mode
node scripts/mcp-test-client.mjs

# Quick calls
node scripts/mcp-test-client.mjs pr_summary 2
node scripts/mcp-test-client.mjs pr_list 2 false  # unresolved only
node scripts/mcp-test-client.mjs pr_get 2 <id>
node scripts/mcp-test-client.mjs pr_invoke 2 coderabbit
```

---

## Debugging Notes

- **MCP Protocol**: Use newline-delimited JSON, NOT Content-Length framing
- **Qodo Detection**: Look for `qodo-code-review[bot]` in issue comments
- **Qodo Marker**: `## PR Reviewer Guide 🔍`
- **Windows**: `MSYS_NO_PATHCONV=1` for `/review` command
