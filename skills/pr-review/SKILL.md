---
name: pr-review
description: "Canonical consumer skill for PR review in this plugin. Delegates autonomous execution to the built-in pr-reviewer background agent and documents the correct relationship between MCP tools, MCP prompts, and Claude skills."
allowed-tools: mcp__pr__*, mcp__aimux__agents, Agent, TaskCreate, TaskUpdate, TaskList, Read, Edit, Write, Grep, Glob, Bash(npm *), Bash(git *)
argument-hint: "[pr-number-or-url]"
---

# pr-review

Use this as the canonical consumer-facing entry for PR review workflows.

## TL;DR

- `pr-reviewer` is the built-in background autonomous executor agent.
- This skill is the canonical consumer-facing entry for dispatching that agent.
- `/pr:review` remains the built-in MCP prompt slash command for MCP-native flows and compatibility, but it is not the primary plugin workflow surface.

## Interface boundaries (must stay explicit)

- **MCP tools**: `mcp__pr__pr_*` (data/actions: summary, list, get, invoke, await, resolve, etc.)
- **MCP prompts / slash commands**: `/pr:review`, `/pr:review-background`, `/pr:setup`
- **Claude skills**: this file (`skills/pr-review/SKILL.md`) and other `SKILL.md` artifacts

## Core workflow

1. Parse input PR target (number, `owner/repo#N`, or URL).
2. Dispatch the built-in `pr-reviewer` agent in background (`model: sonnet`).
3. Let `pr-reviewer` run the full MCP-native review cycle:
   - invoke reviewers (`pr_invoke`)
   - await completion (`pr_await_reviews` / `pr_poll_updates`)
   - process findings (`pr_list`, `pr_get`, code fixes)
   - prefer `mcp__aimux__agents` for larger code changes when aimux is available in the consumer environment
   - otherwise apply fixes locally through the shipped MCP/tool surface
   - resolve fixed threads (`pr_resolve`)
   - hand back structured readiness report
4. Keep merge decision outside the worker (never auto-merge).
5. Use `/pr:review` only when you explicitly want the MCP prompt/slash-command path instead of the built-in plugin agent path.

## Non-negotiable review rules

- Process all severities, including MINOR and NITPICK.
- Confidence-check every suggestion before applying.
- Resolve each fixed thread.
- Hand back with explicit status: READY_FOR_HUMAN_MERGE | NEEDS_USER_DECISION | BLOCKED.

## Anti-patterns

- `Skill("mcp__pr__review")` — wrong abstraction. That is not a Claude skill.
- Treating `/pr:review` as the only plugin-facing interface — wrong. The built-in `pr-reviewer` agent is the primary plugin workflow surface.
- Manual main-context review via `gh pr diff`/`gh api ...comments` as primary review path — wrong. Use the built-in agent or MCP-native prompt/tool flow.
- Auto-merging from autonomous worker — forbidden.
