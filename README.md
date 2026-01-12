# PR Review MCP

MCP server for PR review processing with native Octokit GitHub integration.

## Features

- **Zero Comments Missed** - Cursor pagination fetches all comments
- **Compact Output** - ~2KB per list call instead of 100K+
- **Multi-Agent Support** - CodeRabbit, Gemini, Copilot, Sourcery, Qodo, Codex
- **4-Layer AI Extraction** - High-confidence prompt detection from CodeRabbit comments
- **Native Thread Resolution** - GraphQL mutation (not REST workaround)
- **Qodo Tracker** - Checkbox-based resolution for Qodo's persistent comments
- **Agent Invocation** - Trigger AI reviewers via `pr_invoke`
- **Circuit Breaker** - Resilient to API failures with auto-retry
- **Rate Limit Handling** - Built-in throttling via @octokit plugins

## Installation

### From npm (when published)

```bash
npm install -g pr-review-mcp
```

### Local Development

```bash
# Clone repository
git clone https://github.com/thebtf/pr-review-mcp.git
cd pr-review-mcp

# Install dependencies
npm install

# Build
npm run build

# Link globally (optional)
npm link
```

## Prerequisites

- Node.js 18+
- GitHub Token (see below)
- **External MCP Services** (required for `pr-review` skill):
  - **PR Review MCP** (this server) - provides `pr_*` coordination tools
  - **Serena MCP** - provides code navigation and editing tools

## Configuration

### GitHub Token Setup

**Recommended: Fine-grained Personal Access Token (PAT)**

Create a fine-grained PAT at https://github.com/settings/tokens?type=beta with minimal permissions:

| Permission | Access | Required For |
|------------|--------|--------------|
| Contents | Read | Reading `.github/pr-review.json` config |
| Pull requests | Read/Write | Reading PR comments, resolving threads |
| Issues | Read/Write | Qodo tracker (issue comments) |

**Alternative: Classic PAT** with `repo` scope (broader permissions)

> ⚠️ **Security**: Never commit tokens to source control. Use environment variables or secret managers only.

### Environment Variable

```bash
export GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxxxxxxxxxxx
```

### Claude Desktop Config

| Platform | Config Path |
|----------|-------------|
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

For local development:

```json
{
  "mcpServers": {
    "pr-review": {
      "command": "node",
      "args": ["/path/to/pr-review-mcp/dist/index.js"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}"
      }
    }
  }
}
```

> 💡 Use `${GITHUB_PERSONAL_ACCESS_TOKEN}` to reference an environment variable, or store tokens in a separate `.env` file not committed to git.

After npm publish:

```json
{
  "mcpServers": {
    "pr-review": {
      "command": "npx",
      "args": ["pr-review-mcp"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}"
      }
    }
  }
}
```

## Tools

### `pr_summary`

Get PR review statistics.

```json
{
  "owner": "thebtf",
  "repo": "novascript",
  "pr": 99
}
```

Returns: total, resolved, unresolved, counts by severity and file.

### `pr_list`

List comments with filtering.

```json
{
  "owner": "thebtf",
  "repo": "novascript",
  "pr": 99,
  "filter": { "resolved": false },
  "max": 20
}
```

### `pr_get`

Get detailed comment info including AI prompt.

```json
{
  "owner": "thebtf",
  "repo": "novascript",
  "pr": 99,
  "id": "PRRT_xxx"
}
```

### `pr_resolve`

Mark thread as resolved.

```json
{
  "owner": "thebtf",
  "repo": "novascript",
  "pr": 99,
  "threadId": "PRRT_xxx"
}
```

### `pr_changes`

Incremental fetch since cursor.

```json
{
  "owner": "thebtf",
  "repo": "novascript",
  "pr": 99,
  "cursor": "Y3Vyc29yOjE0..."
}
```

### `pr_invoke`

Invoke AI code review agents.

```json
{
  "owner": "thebtf",
  "repo": "novascript",
  "pr": 99,
  "agent": "all"
}
```

Single agent:
```json
{
  "owner": "thebtf",
  "repo": "novascript",
  "pr": 99,
  "agent": "coderabbit",
  "options": { "focus": "security" }
}
```

Supported agents: `coderabbit`, `sourcery`, `qodo`, `gemini`, `codex`, or `all`

## Required External MCP Services

The `pr-review` and `pr-review-worker` skills depend on external MCP services. These must be configured in your Claude Desktop config.

### PR Review MCP (this server)

**Tools used by orchestrator:**
- `mcp__pr__pr_summary` - Get PR statistics
- `mcp__pr__pr_list_prs` - List open PRs
- `mcp__pr__pr_invoke` - Invoke AI reviewers
- `mcp__pr__pr_claim_work` - Claim file partition (coordination)
- `mcp__pr__pr_report_progress` - Report worker progress
- `mcp__pr__pr_get_work_status` - Check coordination state
- `mcp__pr__pr_reset_coordination` - Reset coordination state

**Tools used by workers:**
- `mcp__pr__pr_claim_work` - Claim next partition
- `mcp__pr__pr_get` - Get comment details with AI prompts
- `mcp__pr__pr_resolve` - Mark thread as resolved
- `mcp__pr__pr_report_progress` - Report completion

**Configuration:** See "Claude Desktop Config" section above.

### Serena MCP

**Purpose:** Code navigation and symbol-level editing for workers.

**Tools used by workers:**
- `mcp__serena__get_symbols_overview` - Get file symbols (replaces Read)
- `mcp__serena__find_symbol` - Find symbol definitions
- `mcp__serena__search_for_pattern` - Search codebase (replaces Grep)
- `mcp__serena__replace_symbol_body` - Edit code (replaces Edit)
- `mcp__serena__find_referencing_symbols` - Find usages

**Configuration:**
```json
{
  "mcpServers": {
    "pr-review": { ... },
    "serena": {
      "command": "npx",
      "args": ["@daymxn/serena-mcp"]
    }
  }
}
```

**Repository:** https://github.com/daymxn/serena

**Behavior on missing tools:** Workers use MCPSearch with one-retry policy. If Serena tools are unavailable after retry, workers will fail with "Unknown tool" errors.

## Workflow Prompt

Use the built-in prompt for automated processing:

```
/pr-review owner:thebtf repo:novascript pr:99
```

This automatically:
1. Gets summary statistics
2. Lists unresolved comments
3. Classifies by priority (HIGH/MEDIUM/LOW)
4. Gets your approval
5. Implements fixes using AI prompts
6. Resolves threads
7. Reports completion status

## Development

```bash
npm install
npm run build
npm run dev  # watch mode
```

## License

MIT
