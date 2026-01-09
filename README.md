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
- GitHub Personal Access Token with `repo` scope

## Configuration

### Environment Variable

Set your GitHub token:

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
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxxxxxxxxxxx"
      }
    }
  }
}
```

After npm publish:

```json
{
  "mcpServers": {
    "pr-review": {
      "command": "npx",
      "args": ["pr-review-mcp"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxxxxxxxxxxx"
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
  "agents": ["coderabbit", "sourcery", "qodo"]
}
```

Supported agents: `coderabbit`, `sourcery`, `qodo`

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
