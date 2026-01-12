# PR Review Skills

Example Claude Code skills for PR review automation.

## Structure

```
skills/
├── pr-review/           # Main orchestrator skill (spawns workers)
│   └── SKILL.md
└── pr-review-worker/    # Internal worker (spawned by orchestrator)
    └── SKILL.md
```

## Usage

Copy `pr-review/` folder to your project's `.claude/skills/` directory.

**Note:** `pr-review-worker` is an internal skill spawned automatically by the orchestrator.
It should NOT be invoked directly by users.

## Skills

| Skill | Purpose | User-invocable |
|-------|---------|----------------|
| `pr-review` | Autonomous multi-agent PR review orchestrator | Yes |
| `pr-review-worker` | Process claimed file partitions | No (internal) |

## Required MCP Services

Both skills require external MCP services configured in Claude Desktop.

### PR Review MCP

The main repository's MCP server provides coordination tools:
- `mcp__pr__pr_claim_work`, `mcp__pr__pr_get`, `mcp__pr__pr_resolve`, `mcp__pr__pr_report_progress` (workers)
- `mcp__pr__pr_summary`, `mcp__pr__pr_list_prs`, `mcp__pr__pr_invoke`, `mcp__pr__pr_get_work_status` (orchestrator)

**Configuration:** See main `README.md` → "Claude Desktop Config"

### Serena MCP

Code navigation and symbol-level editing for workers:
- `mcp__serena__get_symbols_overview` - File symbols (replaces Read)
- `mcp__serena__search_for_pattern` - Search codebase (replaces Grep)
- `mcp__serena__replace_symbol_body` - Edit code (replaces Edit)
- `mcp__serena__find_symbol`, `mcp__serena__find_referencing_symbols` - Symbol lookups

**Install:**
```json
{
  "mcpServers": {
    "serena": {
      "command": "npx",
      "args": ["@daymxn/serena-mcp"]
    }
  }
}
```

**Repository:** https://github.com/daymxn/serena

For full tool list and configuration details, see main `README.md` → "Required External MCP Services"

## Quick Start

```
Review PR #100
Process AI review comments for current PR
```
