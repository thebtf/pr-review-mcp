---
name: pr-review-orchestrator
description: |
  Coordinate parallel PR review processing. Spawns workers, monitors progress, aggregates results.
  Triggers: "orchestrate review", "parallel review", "coordinate workers"
context: fork
agent: background
model: sonnet
allowed-tools:
  - Task
  - Bash
  - mcp__pr-review__pr_summary
  - mcp__pr-review__pr_get_work_status
  - mcp__pr-review__pr_labels
  - mcp__pr-review__pr_invoke
---

# PR Review Orchestrator

Coordinate parallel workers that resolve PR review comments.

---

## EXECUTION MODE: NON-INTERACTIVE

**This skill runs AUTONOMOUSLY. Execute steps 1-8 without stopping.**

- Do NOT ask user for confirmation
- Do NOT present summary and wait
- Do NOT ask "should I continue?"
- IMMEDIATELY proceed through all steps

---

## Inputs (with defaults)

| Input | Default | How to resolve |
|-------|---------|----------------|
| `owner` | - | Infer from `git remote -v` or PR URL in context |
| `repo` | - | Infer from `git remote -v` or PR URL in context |
| `pr` | - | Infer from branch name, PR URL, or recent context |
| `desired_workers` | `3` | Use 3 unless user specifies |
| `agent_id_prefix` | `"worker"` | Use "worker" unless specified |
| `agents` | `["coderabbit", "gemini", "codex", "copilot"]` | All supported agents |

**If owner/repo/pr cannot be inferred:** Extract from git remote once, then proceed.

---

## Workflow

Execute ALL steps automatically. Do NOT stop between steps.

### Step 0: RESOLVE PARAMETERS
```bash
# Get owner/repo from git remote
git remote get-url origin
# Extract: github.com/OWNER/REPO.git -> owner=OWNER, repo=REPO
```
If PR number unknown, check recent PRs or ask ONCE at start.

### Step 1: PREFLIGHT CHECK
```
pr_get_work_status {}
```
- `isActive === true` AND `runAge < 300000` -> **ABORT** (another orchestrator running)
- `isActive === true` AND `runAge >= 300000` -> Stale run, proceed

**-> IMMEDIATELY proceed to Step 2**

### Step 2: LABEL CLEANUP
```
pr_labels { owner, repo, pr, action: "set", labels: ["ai-review:active"] }
```
Atomic set removes stale labels.

**-> IMMEDIATELY proceed to Step 3**

### Step 3: INVOKE REVIEW AGENTS
```
pr_invoke { owner, repo, pr, agent: "all" }
```
Triggers configured agents (coderabbit, gemini, codex, copilot).

**-> IMMEDIATELY proceed to Step 4**

### Step 4: GET SUMMARY
```
pr_summary { owner, repo, pr }
```
Understand scope. Do NOT display to user. Do NOT ask confirmation.

**-> IMMEDIATELY proceed to Step 5**

### Step 5: SPAWN WORKERS
Spawn 3 workers in parallel (single message with multiple Task calls):

```json
{"tool": "Task", "input": {"subagent_type": "general-purpose", "run_in_background": true, "model": "sonnet", "prompt": "Execute skill pr-review-worker. Parameters: agent_id=worker-1, owner=OWNER, repo=REPO, pr=PR_NUMBER. Start immediately."}}
{"tool": "Task", "input": {"subagent_type": "general-purpose", "run_in_background": true, "model": "sonnet", "prompt": "Execute skill pr-review-worker. Parameters: agent_id=worker-2, owner=OWNER, repo=REPO, pr=PR_NUMBER. Start immediately."}}
{"tool": "Task", "input": {"subagent_type": "general-purpose", "run_in_background": true, "model": "sonnet", "prompt": "Execute skill pr-review-worker. Parameters: agent_id=worker-3, owner=OWNER, repo=REPO, pr=PR_NUMBER. Start immediately."}}
```

**-> IMMEDIATELY proceed to Step 6**

### Step 6: MONITOR
Poll every 30s until all partitions complete:
```
pr_get_work_status {}
```
- Check `pendingFiles`, `completedFiles`, `failedFiles`
- If worker stale (>5min), spawn replacement
- Continue until all files processed

**-> IMMEDIATELY proceed to Step 7 when done**

### Step 7: FINAL BUILD & TEST

**MANDATORY: After all workers complete, verify the codebase builds and tests pass.**

```bash
# Detect project type and run build
npm run build   # Node.js/TypeScript
dotnet build    # .NET
cargo build     # Rust
go build ./...  # Go
```

**If build fails:**
1. Analyze error output to identify which file(s) broke
2. Spawn a repair worker to fix compilation errors:
   ```json
   {"tool": "Task", "input": {"subagent_type": "general-purpose", "model": "sonnet", "prompt": "Fix build errors in [FILE]. Error: [ERROR_MESSAGE]. Do not introduce new issues."}}
   ```
3. Re-run build until success

**Run tests:**
```bash
npm test        # or: dotnet test, cargo test, go test ./...
```

**If tests fail:**
1. Identify failing tests
2. If failure is caused by changes made during review -> fix it
3. If failure is pre-existing -> note in report, don't block

**-> IMMEDIATELY proceed to Step 8**

### Step 8: FINAL LABELS
```
pr_labels { owner, repo, pr, action: "set", labels: ["ai-review:complete"] }
# OR if failures:
pr_labels { owner, repo, pr, action: "set", labels: ["ai-review:partial"] }
```

Report summary to user ONLY at the end.

---

## Supported Review Agents

| Agent | Status | Method |
|-------|--------|--------|
| CodeRabbit | Supported | GitHub Checks API |
| Gemini | Supported | PR Reviews |
| Codex | Supported | PR Reviews |
| Copilot | Supported | requested_reviewers + reviews |
| Sourcery | Supported | PR Reviews |
| Qodo | Supported | Issue comments |

---

## FORBIDDEN

```
X Asking user "should I start?"
X Presenting summary and waiting for confirmation
X Asking for missing parameters after Step 0
X Stopping between steps
X Running single-threaded (must spawn parallel workers)
X pr_merge (merging requires human approval)
X Exiting with broken build
```

---

## Quick Start

```
Run pr-review-orchestrator for PR #100
Orchestrate review for thebtf/novascript#42 with 5 workers
```
