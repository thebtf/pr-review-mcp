# PR Review MCP

MCP server for PR review processing with GraphQL-based GitHub integration.

## Features

- **Zero Comments Missed** - Cursor pagination fetches all comments
- **Compact Output** - ~2KB per list call instead of 100K+
- **4-Layer AI Extraction** - High-confidence prompt detection from CodeRabbit comments
- **Native Thread Resolution** - GraphQL mutation (not REST workaround)
- **Circuit Breaker** - Resilient to API failures
- **Workflow Prompt** - Automated 7-step review processing

## Installation

```bash
npm install pr-review-mcp
```

Or run directly:

```bash
npx pr-review-mcp
```

## Prerequisites

- Node.js 18+
- GitHub CLI (`gh`) installed and authenticated: `gh auth login`

## Configuration

Add to Claude Desktop config:

| Platform | Config Path |
|----------|-------------|
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "pr-review": {
      "command": "npx",
      "args": ["pr-review-mcp"]
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
