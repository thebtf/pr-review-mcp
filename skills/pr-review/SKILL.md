---
name: pr-review
description: "Canonical consumer skill for PR review in this plugin. Uses the built-in MCP prompt /pr:review and delegates autonomous execution to the pr-reviewer background agent."
allowed-tools: mcp__pr__*, Agent, TaskCreate, TaskUpdate, TaskList, Read, Edit, Write, Grep, Glob, Bash(npm *), Bash(git *)
argument-hint: "[pr-number-or-url]"
---

# pr-review

Use this as the canonical consumer-facing entry for PR review workflows.

## TL;DR

- `/pr:review` is the built-in MCP prompt slash command.
- `pr-reviewer` is the background autonomous executor agent.
- This skill coordinates them so review work runs through MCP tools, not ad-hoc CLI scraping.

## Interface boundaries (must stay explicit)

- **MCP tools**: `mcp__pr__pr_*` (data/actions: summary, list, get, invoke, await, resolve, etc.)
- **MCP prompts / slash commands**: `/pr:review`, `/pr:review-background`, `/pr:setup`
- **Claude skills**: this file (`skills/pr-review/SKILL.md`) and other `SKILL.md` artifacts

## Core workflow

1. Parse input PR target (number, `owner/repo#N`, or URL).
2. Start with the built-in MCP prompt: `/pr:review ...`.
3. Delegate autonomous execution to `pr-reviewer` in background (`model: sonnet`).
4. Let `pr-reviewer` run full cycle:
   - invoke reviewers (`pr_invoke`)
   - await completion (`pr_await_reviews` / `pr_poll_updates`)
   - process findings (`pr_list`, `pr_get`, code fixes)
   - resolve fixed threads (`pr_resolve`)
   - hand back structured readiness report
5. Keep merge decision outside the worker (never auto-merge).

## Non-negotiable review rules

- Process all severities, including MINOR and NITPICK.
- Confidence-check every suggestion before applying.
- Resolve each fixed thread.
- Hand back with explicit status: ready, needs decision, or blocked.

## Anti-patterns

- `Skill("mcp__pr__review")` — wrong abstraction. That is not a Claude skill.
- Manual main-context review via `gh pr diff`/`gh api ...comments` as primary review path — wrong. Use MCP prompt + MCP tools flow.
- Auto-merging from autonomous worker — forbidden.
