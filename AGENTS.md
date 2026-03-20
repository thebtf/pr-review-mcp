# AGENTS.md — PR Review MCP Server

## 🎯 PURPOSE

MCP server for processing PR reviews from multiple AI code review agents (CodeRabbit, Gemini, Copilot, Sourcery, Qodo).

**Features:**
- GraphQL-based GitHub integration with cursor pagination
- Multi-source comment detection and severity extraction
- AI prompt extraction from review comments
- Agent invocation (`pr_invoke`)

---

## 🛑 LANGUAGE

- **Communication with user:** RUSSIAN
- **Code, commits, docs:** ENGLISH

---

## 📁 PROJECT STRUCTURE

```
pr-review-mcp/
├── src/
│   ├── server.ts           # MCP server entry point
│   ├── github/
│   │   ├── client.ts       # GitHub CLI wrapper
│   │   ├── queries.ts      # GraphQL queries
│   │   └── types.ts        # TypeScript types
│   ├── tools/
│   │   ├── summary.ts      # pr_summary tool
│   │   ├── list.ts         # pr_list tool
│   │   ├── get.ts          # pr_get tool
│   │   ├── resolve.ts      # pr_resolve tool
│   │   ├── changes.ts      # pr_changes tool
│   │   ├── invoke.ts       # pr_invoke tool
│   │   └── shared.ts       # Shared utilities
│   ├── adapters/
│   │   ├── qodo.ts         # Qodo issue comment adapter
│   │   └── greptile.ts     # Greptile issue comment adapter
│   ├── agents/
│   │   ├── registry.ts     # Agent configurations
│   │   ├── invoker.ts      # Agent invocation logic
│   │   └── detector.ts     # Smart agent detection
│   └── extractors/
│       ├── severity.ts     # Severity extraction
│       └── prompt.ts       # AI prompt extraction
└── dist/                   # Compiled output
```

---

## 🔧 MCP TOOLS

| Tool | Description |
|------|-------------|
| `pr_summary` | Get PR statistics (total, resolved, by severity/file) |
| `pr_list` | List comments with filtering (resolved, file, source) |
| `pr_get` | Get full comment details + AI prompt |
| `pr_resolve` | Mark review thread as resolved |
| `pr_changes` | Incremental updates with cursor pagination |
| `pr_invoke` | Invoke AI agents with smart detection (skips agents that already reviewed) |

---

## 🧪 TESTING

**MCP Protocol Testing** (NOT direct function calls):

```javascript
// Spawn server and communicate via newline-delimited JSON
const server = spawn('node', ['dist/index.js']);
server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {...} }) + '\n');
```

**Test PR:** `thebtf/pr-review-mcp#2` (72+ comments from 6 agents)

---

## 📝 AGENT SOURCES

| Source | Type | Detection |
|--------|------|-----------|
| CodeRabbit | Inline reviews | `coderabbitai[bot]` |
| Gemini | Inline reviews | `gemini-code-assist[bot]` |
| Copilot | Inline reviews | `copilot-pull-request-reviewer[bot]` |
| Sourcery | Inline reviews | `sourcery-ai[bot]` |
| Codex | Inline reviews | `chatgpt-codex-connector[bot]` |
| **Qodo** | **Issue comment** | `qodo-code-review[bot]` |
| **Greptile** | **Issue comment + inline** | `greptile-code-reviews[bot]` |

⚠️ Qodo uses a "persistent review" pattern — one issue comment updated on each commit.
⚠️ Greptile posts an overview issue comment + inline review comments.

---

## 🧠 SMART DETECTION

`pr_invoke` includes smart detection to avoid re-invoking agents that already reviewed:

**Default behavior:**
- Detects agents that already submitted reviews (by author login)
- Skips agents that already reviewed → returns in `skipped` array
- Only CodeRabbit is invoked by default (configurable via `.github/pr-review.json`)

**Options:**
| Option | Description |
|--------|-------------|
| `force: true` | Re-invoke agents even if they already reviewed |
| `agent: "all"` | Invoke all configured agents (default: only CodeRabbit) |
| `agent: "coderabbit"` | Invoke specific agent |

**Response includes:**
```json
{
  "invoked": ["CodeRabbit"],
  "skipped": ["Gemini", "Codex"],
  "failed": [],
  "message": "Invoked: CodeRabbit. Skipped (already reviewed): Gemini, Codex"
}
```

---

## ⚠️ RULES

| Rule | Description |
|------|-------------|
| **Test via MCP** | Always test through MCP protocol, not direct imports |
| **No gh CLI in tests** | Use MCP tools, not raw `gh` commands |
| **PR ops via MCP only** | **CRITICAL:** All PR operations must go through MCP server, never direct `gh` CLI |
| **Parallel fetching** | Fetch review threads + Qodo in parallel |
| **Windows compat** | Use `MSYS_NO_PATHCONV=1` for slash commands |

---

## 🚀 COMMANDS

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
