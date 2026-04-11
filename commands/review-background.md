---
name: review-background
description: Fire-and-forget autonomous PR review. Self-manages TaskList progress while your session stays free.
arguments:
  - name: pr
    description: "PR number, GitHub URL (https://github.com/owner/repo/pull/123), or short format (owner/repo#123). Omit to process all open PRs."
    required: false
  - name: workers
    description: "Number of parallel workers (default: 3)"
    required: false
---

# Background PR Review

Use the `review-background` prompt from the `pr` MCP server to start a fire-and-forget autonomous PR review session.

## Steps

1. Call the `review-background` prompt from the `pr` MCP server with the provided arguments.
2. The prompt creates and manages its own TaskList progress state.
3. Let the autonomous workflow process reviewer comments and report completion when ready.

## Usage

```
/pr:review-background              — All PRs in current repo
/pr:review-background 42           — PR #42 in current repo
/pr:review-background owner/repo#5 — Specific PR in any repo
```
