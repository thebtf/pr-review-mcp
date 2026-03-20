---
name: review
description: Autonomous multi-agent PR review. Process all AI review comments until ready for merge.
arguments:
  - name: pr
    description: "PR number, GitHub URL (https://github.com/owner/repo/pull/123), or short format (owner/repo#123). Omit to process all open PRs."
    required: false
  - name: workers
    description: "Number of parallel workers (default: 3)"
    required: false
---

# PR Review Orchestrator

Use the `pr:review` MCP prompt to start an autonomous PR review session.

## Steps

1. Call the `review` prompt from the `pr` MCP server with the provided arguments
2. The prompt returns a pre-built orchestration plan with:
   - PR metadata and current review state
   - Unresolved comment partitions grouped by file
   - Worker spawn instructions for parallel processing
3. Follow the orchestration plan to process all comments

## Usage

```
/pr:review              — All PRs in current repo
/pr:review 42           — PR #42 in current repo
/pr:review owner/repo#5 — Specific PR in any repo
```
