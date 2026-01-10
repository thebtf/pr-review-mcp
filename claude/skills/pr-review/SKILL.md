---
name: pr-review
description: |
  Autonomous multi-agent PR review orchestrator. Spawns parallel workers to process all AI review comments until PR is ready for merge.
  Supports CodeRabbit, Gemini, Codex, Sourcery, Qodo, Copilot agents.

  Triggers: "review PR", "PR review", "process comments", "AI review", "orchestrate review", "review cycle"
context: fork
agent: background
model: sonnet
allowed-tools:
  - Task
  - Bash
  - Read
  - mcp__pr-review__pr_summary
  - mcp__pr-review__pr_get_work_status
  - mcp__pr-review__pr_labels
  - mcp__pr-review__pr_invoke
  - mcp__pr-review__pr_poll_updates
---

# PR Review Orchestrator

Autonomous multi-agent PR review. Spawns parallel workers, monitors progress, ensures build passes.

---

## EXECUTION MODE: NON-INTERACTIVE

**This skill runs AUTONOMOUSLY. Execute all steps without stopping.**

- Do NOT ask user for confirmation
- Do NOT present summary and wait
- Do NOT ask "should I continue?"
- IMMEDIATELY proceed through all steps

---

## CRITICAL SAFETY RULES

| Rule | Enforcement |
|------|-------------|
| **NO AUTO-MERGE** | NEVER call `pr_merge`. Report readiness only. |
| **HUMAN GATE** | All merges require explicit user approval |
| **ESCAPE HATCH** | Stop immediately if `pause-ai-review` label present |
| **FIX ALL** | Process ALL comments regardless of severity. No skipping. |
| **BUILD MUST PASS** | Never finish with broken build or failing tests. |
| **OUT OF SCOPE** | Never dismiss as "out of scope" without tech debt entry. |

---

## State Machine

```
INIT -> ESCAPE_CHECK -> INVOKE_AGENTS -> POLL_WAIT
                                            |
                       +--------------------+--------------------+
                       |                                         |
                 allAgentsReady?                           pause label?
                       |                                         |
                 +-----+-----+                              STOP (user)
                 no          yes
                 |            |
              (wait)    unresolved > 0?
                             |
                       +-----+-----+
                       yes         no
                       |            |
                SPAWN_WORKERS    BUILD_TEST -> COMPLETE
                       |
                       v
                   MONITOR
                       |
                       v
                  BUILD_TEST
                       |
                       +---> POLL_WAIT (re-review cycle)
```

---

## Inputs (with defaults)

| Input | Default | How to resolve |
|-------|---------|----------------|
| `owner` | - | Infer from `git remote -v` or PR URL in context |
| `repo` | - | Infer from `git remote -v` or PR URL in context |
| `pr` | - | Infer from branch name, PR URL, or recent context |
| `desired_workers` | `3` | Use 3 unless user specifies |
| `agents` | `["coderabbit", "gemini", "codex", "copilot"]` | All supported agents |

**If owner/repo/pr cannot be inferred:** Extract from git remote once, then proceed.

---

## Workflow

Execute ALL steps automatically. Do NOT stop between steps.

### Step 0: RESOLVE PARAMETERS
```bash
git remote get-url origin
# Extract: github.com/OWNER/REPO.git -> owner=OWNER, repo=REPO
```
If PR number unknown, check recent PRs or ask ONCE at start.

**-> IMMEDIATELY proceed to Step 1**

### Step 1: ESCAPE CHECK

```
pr_labels { owner, repo, pr, action: "get" }
```

- If `pause-ai-review` label present -> **STOP**, report "Paused by user"
- If PR closed/merged -> **STOP**, report "PR closed externally"

**-> IMMEDIATELY proceed to Step 2**

### Step 2: PREFLIGHT CHECK
```
pr_get_work_status {}
```
- `isActive === true` AND `runAge < 300000` -> **ABORT** (another orchestrator running)
- `isActive === true` AND `runAge >= 300000` -> Stale run, proceed

**-> IMMEDIATELY proceed to Step 3**

### Step 3: LABEL CLEANUP
```
pr_labels { owner, repo, pr, action: "set", labels: ["ai-review:active"] }
```
Atomic set removes stale labels.

**-> IMMEDIATELY proceed to Step 4**

### Step 4: INVOKE REVIEW AGENTS
```
pr_invoke { owner, repo, pr, agent: "all" }
```
Triggers configured agents (coderabbit, gemini, codex, copilot, sourcery, qodo).

**-> IMMEDIATELY proceed to Step 5**

### Step 5: POLL & WAIT
```
pr_poll_updates { owner, repo, pr, include: ["comments", "agents"] }
```

Check convergence:
- `allAgentsReady: false` -> wait 30s, poll again
- `allAgentsReady: true, unresolved > 0` -> proceed to Step 6
- `allAgentsReady: true, unresolved === 0` -> proceed to Step 8

**-> IMMEDIATELY proceed based on condition**

### Step 6: SPAWN WORKERS

Spawn 3 workers in parallel (single message with multiple Task calls):

```json
{"tool": "Task", "input": {"subagent_type": "general-purpose", "run_in_background": true, "model": "sonnet", "prompt": "Execute skill pr-review-worker. Parameters: agent_id=worker-1, owner=OWNER, repo=REPO, pr=PR_NUMBER, spawned_by_orchestrator=true. Start immediately."}}
{"tool": "Task", "input": {"subagent_type": "general-purpose", "run_in_background": true, "model": "sonnet", "prompt": "Execute skill pr-review-worker. Parameters: agent_id=worker-2, owner=OWNER, repo=REPO, pr=PR_NUMBER, spawned_by_orchestrator=true. Start immediately."}}
{"tool": "Task", "input": {"subagent_type": "general-purpose", "run_in_background": true, "model": "sonnet", "prompt": "Execute skill pr-review-worker. Parameters: agent_id=worker-3, owner=OWNER, repo=REPO, pr=PR_NUMBER, spawned_by_orchestrator=true. Start immediately."}}
```

**-> IMMEDIATELY proceed to Step 7**

### Step 7: MONITOR WORKERS
```
pr_get_work_status {}
```
Poll every 30s until all partitions complete:
- Check `pendingFiles`, `completedFiles`, `failedFiles`
- If worker stale (>5min), spawn replacement
- Continue until all files processed

**-> IMMEDIATELY proceed to Step 8 when done**

### Step 8: BUILD & TEST

**MANDATORY: Verify codebase builds and tests pass.**

```bash
npm run build   # Node.js/TypeScript
dotnet build    # .NET
cargo build     # Rust
go build ./...  # Go
```

**If build fails:**
1. Analyze error output
2. Spawn repair worker to fix
3. Re-run build until success
4. **DO NOT proceed with broken build**

**Run tests:**
```bash
npm test        # or: dotnet test, cargo test, go test ./...
```

**If tests fail:**
- Caused by review changes -> fix it
- Pre-existing -> note in report, continue

**-> Return to Step 5 (poll for re-review) OR proceed to Step 9**

### Step 9: COMPLETION

```
pr_labels { owner, repo, pr, action: "set", labels: ["ai-review:passed"] }
# OR if issues:
pr_labels { owner, repo, pr, action: "set", labels: ["ai-review:needs-attention"] }
```

Report to user (DO NOT MERGE):
```
PR Review Complete. Build and tests passing. Ready for human review.
```

---

## Convergence Conditions

**EXIT condition (success):**
```
allAgentsReady === true AND unresolved === 0 AND build passes AND tests pass
```

ALL must be true simultaneously.

| Condition | Action |
|-----------|--------|
| `allAgentsReady: false` | Wait - agents still reviewing |
| `allAgentsReady: true, unresolved > 0` | Spawn workers (Step 6) |
| `allAgentsReady: true, unresolved === 0` | Build & Test -> Completion |
| `pause-ai-review` label | **STOP** - User requested |
| PR closed/merged | **STOP** - External action |
| Build fails | Fix errors, do NOT proceed |

---

## Handling "Out of Scope" Comments

If a comment requires work beyond current PR scope:

```
1. ESTIMATE effort (lines of code, files affected, complexity)

2. If truly large (>1 day work, architectural change):
   a. Add entry to .agent/status/TECH_DEBT_PLAN.md:
      - Problem description
      - Affected files/components
      - Estimated effort
      - Link to original PR comment
   b. Reply to comment with tech debt reference
   c. THEN resolve thread

3. If small-medium (<1 day): just fix it in this PR

NEVER just say "out of scope" without adding tech debt entry.
```

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

## Label Convention

| Label | Meaning |
|-------|---------|
| `ai-review:active` | Review in progress |
| `ai-review:passed` | Ready for merge (0 unresolved, build passes) |
| `ai-review:needs-attention` | Has unresolved comments or build issues |
| `pause-ai-review` | **Escape hatch** - stops automation |

---

## Error Handling

| Error | Action |
|-------|--------|
| Tool call fails | Retry 3x with backoff |
| Agent timeout | Skip agent, continue |
| PR closed externally | Stop gracefully |
| Network error | Wait 60s, retry |
| Build failure | Fix and retry |
| Test failure | Analyze and fix if caused by changes |
| Unknown error | Set `ai-review:error` label, stop |

---

## FORBIDDEN

```
X pr_merge - merging requires human approval
X Ignoring pause-ai-review label
X Marking ANY comment resolved without fixing
X Skipping comments (regardless of severity)
X "Out of scope" without tech debt entry
X Exiting with unresolved comments
X Exiting with broken build
X Asking user "should I start?"
X Presenting summary and waiting for confirmation
X Running single-threaded (must spawn parallel workers)
```

---

## Quick Start

```
Review PR #100
Review PR thebtf/novascript#42 with 5 workers
Process AI review comments for current PR
```
