---
name: review
description: "Autonomous AI-driven PR review orchestrator. Invokes review agents (CodeRabbit, Gemini, Codex), awaits their completion server-side, processes all findings, and runs build verification. Use this skill whenever a PR needs AI code review — after creating a PR, when review comments need processing, when asked to 'review PR', 'run review', 'check this PR', or any mention of PR review workflow. Works with any GitHub repository."
allowed-tools: mcp__pr__*, Agent, TaskCreate, TaskUpdate, TaskList, Read, Edit, Write, Grep, Glob, Bash(npm *), Bash(git *)
argument-hint: "[pr-number-or-url]"
---

# PR Review Orchestrator

Autonomous multi-agent PR review: invoke AI agents, await their reviews, process all findings, verify build.

## How It Works

This skill calls the `review` MCP prompt from the `pr` server. The prompt dynamically builds an orchestration plan with pre-fetched PR data (summary, work status, agent config). The plan includes:

1. **Delegation instructions** — create tracking tasks, spawn a background sonnet agent
2. **Full orchestrator workflow** — escape check, invoke, await, spawn workers, build/test
3. **Worker templates** — for parallel comment processing

You don't need to understand the internals — just call the prompt and follow its instructions.

## Invocation

```
/pr:review              — Context-dependent (see below)
/pr:review 42           — PR #42 in current repo
/pr:review owner/repo#5 — Specific PR in any repo
/pr:review https://github.com/owner/repo/pull/123 — Full URL
```

**No-argument behavior depends on current branch:**
- **Feature branch** → auto-detects the PR for this branch (single PR mode)
- **Main/master** → processes all open PRs with unresolved review comments (batch mode, up to 20)
- **Main/master + no PRs with comments** → processes first 5 open PRs

## Workflow

### Step 1: Call the MCP Prompt

```
Use the `review` prompt from the `pr` MCP server, passing $ARGUMENTS as the `pr` parameter.
```

The prompt returns a complete orchestration plan. It has two sections:
- **DELEGATION** — instructions for YOU (the parent agent)
- **ORCHESTRATOR PROMPT** — instructions for the background agent you'll spawn

### Step 2: Follow the Delegation Plan

The delegation section tells you to:

1. **Create 4 tracking tasks** via TaskCreate:
   - Preflight checks
   - Wait for AI agent reviews
   - Process review comments
   - Build and test

2. **Spawn a background agent** via `Agent(model: "sonnet", run_in_background: true)` with the ORCHESTRATOR PROMPT section as its prompt.

3. **Monitor progress** — when the background agent sends progress notifications, call `pr_progress_check` and update your tasks accordingly.

### Step 3: Stay Available

While the background agent works autonomously, you remain free to handle other user requests. The background agent:
- Invokes review agents (`pr_invoke`)
- Waits for reviews server-side (`pr_await_reviews` — blocks internally, not you)
- Spawns parallel workers to process comments
- Runs build and tests
- Reports completion

You'll be notified when it finishes. Update tasks and report results to the user.

## Key Tools Used by the Orchestrator

| Tool | Purpose |
|------|---------|
| `pr_invoke` | Trigger AI review agents, get `since` + `invokedAgentIds` |
| `pr_await_reviews` | Block server-side until agents post reviews (up to 10 min) |
| `pr_summary` | Get review statistics |
| `pr_claim_work` | Claim file partition for comment processing |
| `pr_get` | Read full comment details |
| `pr_resolve` | Mark thread as resolved after fixing |
| `pr_labels` | Set review status labels |
| `pr_progress_update` | Report orchestrator phase transitions |

## Edge Cases

- **No PR specified + on feature branch**: auto-detects PR for current branch (single PR mode)
- **No PR specified + on main/master**: processes all open PRs with unresolved comments (batch mode)
- **PR on different branch**: refuses with branch protection message — switch to the right branch first
- **Another orchestrator already running**: detects via preflight check, aborts if run is fresh (<5 min)
- **Agent already reviewed**: smart detection skips agents that already posted reviews (use `force` in `pr_invoke` options to override)
- **All comments resolved, no unresolved**: skips worker spawning, goes straight to build/test

## Comment Processing Rules (MANDATORY)

**ALL severities MUST be processed. Skipping = FAILURE:**
- CRIT and MAJOR — fix immediately
- MINOR — you MUST fix. "Too minor" is NOT a valid reason to skip.
- NITPICK — you MUST fix. Code quality at every level is required.

**You MUST confidence-check EVERY suggestion BEFORE applying it:**
AI review agents produce WRONG suggestions. Blindly applying them breaks code.
1. READ the suggestion. VERIFY it is factually correct.
2. If CORRECT → apply the fix, resolve the thread.
3. If WRONG → resolve the thread with a reply explaining WHY it is incorrect.
4. BLINDLY APPLYING a wrong suggestion = FAILURE. SKIPPING a correct one = FAILURE.

## What NOT to Do

- Don't call `pr_list`, `pr_get`, `pr_resolve`, `Read`, `Edit` yourself — that's the workers' job
- Don't process comments directly — spawn workers via the orchestrator
- Don't call `pr_merge` — review completes, human merges
- NEVER skip MINOR/NITPICK comments — you MUST process ALL severities
- NEVER blindly apply a suggestion — you MUST verify it is correct first
