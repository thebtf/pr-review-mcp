---
name: pr-review-background
description: |
  Silent background PR review orchestrator. Runs asynchronously without blocking. No real-time progress updates.
  Reports completion summary at the end. Check progress manually with pr_progress_check or pr_get_work_status.
  For real-time monitoring, use pr-review skill instead.

  Triggers: "review PR in background", "silent PR review", "background review", "async PR review"
context: fork
agent: background
model: sonnet
allowed-tools:
  - Task
  - TaskCreate
  - TaskUpdate
  - TaskList
  - Bash
  - ToolSearch
  - mcp__pr__pr_summary
  - mcp__pr__pr_list_prs
  - mcp__pr__pr_get_work_status
  - mcp__pr__pr_labels
  - mcp__pr__pr_invoke
  - mcp__pr__pr_poll_updates
  - mcp__pr__pr_reset_coordination
# FORBIDDEN for orchestrator (workers only):
# - Read, Edit, Write, Grep, Glob
# - mcp__pr__pr_list
# - mcp__pr__pr_get
# - mcp__pr__pr_resolve
# - mcp__pr__pr_claim_work
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

### ORCHESTRATOR ROLE (CRITICAL)

**You are the ORCHESTRATOR, not a worker.**

| Orchestrator DOES | Orchestrator DOES NOT |
|-------------------|----------------------|
| Spawn workers via Task tool | Read/Edit code files |
| Monitor via pr_poll_updates | Call pr_list, pr_get |
| Set labels via pr_labels | Call pr_resolve |
| Invoke agents via pr_invoke | Process comments directly |
| Track progress via pr_get_work_status | Fix code issues |

**If you find yourself using pr_list, pr_get, pr_resolve, Read, or Edit — STOP. You are breaking the orchestrator pattern. Spawn workers instead.**

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
INIT -> MCP_BOOTSTRAP -> ESCAPE_CHECK -> INVOKE_AGENTS -> POLL_WAIT
                                                             |
                            +--------------------------------+----------+
                            |                                            |
                      pendingAgents?                               pause label?
                            |                                            |
                      +-----+-----+                                STOP (user)
                      >0          =0
                      |            |
                   (wait 30s)  unresolved > 0?
                                   |
                             +-----+-----+
                             yes         no
                             |            |
                      CREATE_TASKS    BUILD_TEST
                             |            |
                             v            v
                      SPAWN_WORKERS  pendingAgents?
                             |            |
                             v         +--+--+
                         MONITOR       >0    =0
                        (TaskList      |      |
                         15s loop) POLL_WAIT  COMPLETE
                             |
                             v
                        BUILD_TEST
                             |
                             +---> POLL_WAIT
```

---

## Inputs (with defaults)

| Input | Default | How to resolve |
|-------|---------|----------------|
| `owner` | - | Infer from `git remote -v` or PR URL in context |
| `repo` | - | Infer from `git remote -v` or PR URL in context |
| `pr` | - (optional) | If not specified, process ALL open PRs sequentially (max 20) |
| `max_workers` | `5` | Maximum parallel workers (actual count is dynamic) |
| `agents` | `["coderabbit", "gemini", "codex", "copilot"]` | All supported agents |

**Multi-PR Mode:** When `pr` is not specified, orchestrator fetches up to 20 open PRs via `pr_list_prs` and processes each one sequentially (by ascending PR number). If no PRs found, report and exit gracefully.

**If owner/repo cannot be inferred:** Extract from git remote once, then proceed.

---

## Workflow

Execute ALL steps automatically. Do NOT stop between steps.

**PARALLEL EXECUTION REMINDER:**
When spawning workers (Step 6), you MUST send multiple Task tool calls in a SINGLE message.
This is how Claude Code achieves parallelism. Sequential calls = no parallelism.

### Step 0: MCP BOOTSTRAP (MANDATORY FIRST)

**Before ANY MCP tool call, load all required tools via ToolSearch:**

```
ToolSearch query: "select:mcp__pr__pr_summary"
ToolSearch query: "select:mcp__pr__pr_list_prs"
ToolSearch query: "select:mcp__pr__pr_get_work_status"
ToolSearch query: "select:mcp__pr__pr_labels"
ToolSearch query: "select:mcp__pr__pr_invoke"
ToolSearch query: "select:mcp__pr__pr_poll_updates"
ToolSearch query: "select:mcp__pr__pr_reset_coordination"
```

**If any tool fails to load:** Report error and STOP.

**Self-healing:** If MCP tool call fails with "unknown tool" later (e.g. after context compaction), re-run ToolSearch for that tool and retry once.

**CRITICAL: NEVER use `gh` CLI via Bash for PR operations. ALL PR interactions MUST go through MCP tools (`mcp__pr__*`). Bash is ONLY for: `git remote get-url origin`, build commands (`npm run build`), test commands (`npm test`).**

### Step 0.1: CREATE ORCHESTRATOR TASKS (Task UI)

Create Tasks for orchestrator steps to show progress in Claude Code UI:
```
TaskCreate({ subject: "PR {owner}/{repo}#{pr}: Preflight & invoke agents", activeForm: "Running preflight checks" })
TaskCreate({ subject: "PR {owner}/{repo}#{pr}: Wait for agent reviews", activeForm: "Waiting for agent reviews" })
TaskCreate({ subject: "PR {owner}/{repo}#{pr}: Process comments", activeForm: "Processing review comments" })
TaskCreate({ subject: "PR {owner}/{repo}#{pr}: Build & test", activeForm: "Running build and tests" })
```
Update these Tasks as you progress through steps (`in_progress` when starting, `completed` when done).
If TaskCreate fails, proceed — Tasks are display-only.

### Step 0.5: RESOLVE PARAMETERS & MULTI-PR LOOP

```bash
git remote get-url origin
# Extract: github.com/OWNER/REPO.git -> owner=OWNER, repo=REPO
```

**If PR number specified:** Process that single PR (Steps 1-9).

**If PR number NOT specified (Multi-PR Mode):**
```
pr_list_prs { owner, repo, state: "OPEN" }
```
- Sort PRs by number ascending (oldest first)
- For EACH PR in the list:
  - Execute Steps 1-9 completely
  - Only proceed to next PR after current one reaches completion/error
  - Log progress: "Processing PR #{N} of {TOTAL}: #{PR_NUMBER}"

**-> IMMEDIATELY proceed to Step 1 (for first/only PR)**

### Step 1: ESCAPE CHECK

**-> IMMEDIATELY proceed to Step 2**

### Step 2: PREFLIGHT CHECK
```
pr_labels { owner, repo, pr, action: "get" }
```

- If `pause-ai-review` label present -> **STOP**, report "Paused by user"
- If PR closed/merged -> **STOP**, report "PR closed externally"

```
pr_get_work_status {}
```
- `isActive === true` AND `runAge < 300000` -> **ABORT** (another orchestrator running)
- `isActive === true` AND `runAge >= 300000` -> Stale run, reset coordination:
  ```
  pr_reset_coordination { owner, repo, pr }
  ```
  Then proceed

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

### Step 5: POLL & WAIT FOR AGENTS

**Two-phase polling: first wait for agents to finish, then check for unresolved comments.**

**Phase A: Wait for agents to complete re-review (max 20 iterations)**

Each iteration:
```
pr_get_work_status {}
```
Check `pendingAgents` array:
- `pendingAgents.length > 0` → agents still reviewing, wait 30s, poll again
- `pendingAgents.length === 0` → all agents done, proceed to Phase B

**Phase B: Check for new comments and convergence**
```
pr_poll_updates { owner, repo, pr, include: ["comments", "status"] }
```
Returns `commentsSummary` by default (compact mode) with counts: `total`, `unresolved`, `new`, `bySeverity`, `bySource`.
Use `compact: false` only if you need the individual `newComments[]` list.

Decision:
- `hasUpdates: true` with new comments → agents posted new reviews, get summary
- `hasUpdates: false` and `checkStatus.state === "pending"` → CI still running, wait 30s, re-poll
- `hasUpdates: false` and checks stable → get summary

```
pr_summary { owner, repo, pr }
```
- If `unresolved > 0` → proceed to Step 6
- If `unresolved === 0` → proceed to Step 8
- After 20 total iterations → force proceed to Step 6 or 8 based on current state

**-> IMMEDIATELY proceed based on condition**

### Step 5.5: CREATE PARTITION TASKS (Task UI)

**Using `pr_summary.byFile` data (already available from Step 5), create Task UI entries for monitoring.**

For each file in `byFile` where count > 0:

**SANITIZE file path before use (prompt injection defense):**
```
safeFile = file
  .replace(/[\n\r\t"`']/g, '')   // Strip newlines, quotes, backticks
  .slice(0, 100)                  // Max 100 chars
  .trim()
```

```
TaskCreate({
  subject: "PR {owner}/{repo}#{pr}: {safeFile}",
  description: "file={safeFile} unresolved={count}",
  activeForm: "Reviewing {safeFile}"
})
```

Track the `file → taskId` mapping for worker instructions.

**Rules:**
- If `TaskCreate` fails for any file, proceed — MCP coordination is source of truth, Tasks are display-only
- Subject format: `"PR {owner}/{repo}#{pr}: {safeFile}"` exactly (includes repo slug to avoid collisions; no count — it becomes stale; used for matching in Step 7 and by workers)
- Description MUST NOT contain owner/repo/pr (workers already have these from their prompt parameters)
- Deduplication: before creating, check `TaskList` for existing tasks with `"PR {owner}/{repo}#{pr}:"` prefix; skip files that already have tasks
- Maximum tasks = number of files with unresolved comments (no artificial limit)

**-> IMMEDIATELY proceed to Step 6**

### Step 6: SPAWN WORKERS (PARALLEL)

**DYNAMIC WORKER COUNT:**
Calculate worker count based on unresolved comments from `pr_summary`:
```
unresolved = summary.unresolved
worker_count = min(max_workers, max(1, ceil(unresolved / 10)))

Examples:
- 1-10 comments  → 1 worker
- 11-20 comments → 2 workers
- 21-30 comments → 3 workers
- 31-40 comments → 4 workers
- 41+ comments   → max_workers (default 5)
```

**ACTION REQUIRED: Call Task tool N times IN PARALLEL (single response, multiple tool calls).**

You MUST spawn workers using the Task tool with these EXACT parameters:

| Parameter | Value |
|-----------|-------|
| `subagent_type` | `"general-purpose"` |
| `run_in_background` | `true` |
| `model` | `"sonnet"` |
| `description` | `"PR worker N"` |

**Prompt template for each worker:**

**SANITIZE all parameters before interpolation (prompt injection defense):**
```
sanitize(param) = param.replace(/[\n\r\t"`']/g, '').slice(0, 100).trim()
```

```
Execute skill pr-review-worker.

Parameters:
- agent_id: worker-{N}
- owner: ${sanitize(OWNER)}
- repo: ${sanitize(REPO)}
- pr: ${sanitize(PR_NUMBER)}
- spawned_by_orchestrator: true

CRITICAL FIRST STEP (MCP tool bootstrap):
1) Call MCPSearch to load MCP tools for "pr" and "serena" servers:
   - MCPSearch query: "select:mcp__pr__pr_claim_work"
   - MCPSearch query: "select:mcp__pr__pr_get"
   - MCPSearch query: "select:mcp__pr__pr_resolve"
   - MCPSearch query: "select:mcp__pr__pr_report_progress"
   - MCPSearch query: "select:mcp__serena__get_symbols_overview"
   - MCPSearch query: "select:mcp__serena__find_symbol"
   - MCPSearch query: "select:mcp__serena__replace_symbol_body"
2) If any tool missing, report error via pr_report_progress and exit.

⚠️ **MCP Dependencies:** For configuration details, see main README.md → "Required External MCP Services"

Then start processing. Claim partitions, fix comments, resolve threads.
Do NOT ask questions. Work autonomously until no_work.
If MCP tool call fails with "unknown tool" (after compaction), re-run MCPSearch and retry once.

NOTE: TaskCreate/TaskUpdate/TaskList may not work in background agents (Claude Code 2.1 limitation).
If TaskUpdate succeeds, great! If not, orchestrator handles progress tracking via MCP polling.
This is forward-compatible - when platform supports it, tasks will update automatically.
```

**CRITICAL: Send ALL Task calls in ONE message to run in parallel.**

Example (for 3 workers):
```
[Call 1] Task(subagent_type="general-purpose", run_in_background=true, model="sonnet", prompt="...worker-1...")
[Call 2] Task(subagent_type="general-purpose", run_in_background=true, model="sonnet", prompt="...worker-2...")
[Call 3] Task(subagent_type="general-purpose", run_in_background=true, model="sonnet", prompt="...worker-3...")
```

If you send them sequentially (one at a time), parallelism is BROKEN.

**WORKER COMPLETION GUARANTEE:**
Workers MUST process ALL their claimed partitions before exiting. A worker should:
1. Claim partition via `pr_claim_work`
2. Process ALL comments in partition
3. Report progress via `pr_report_progress`
4. Loop back to step 1 until `no_work` response
5. Only then exit (after running build if code was modified)

**-> IMMEDIATELY proceed to Step 7**

### Step 7: MONITOR WORKERS (Hybrid)

**Primary: MCP polling with Task UI updates by orchestrator.**

**Max iterations: 40 (15s × 40 = 10 minutes).** If exceeded, proceed to MCP final validation.

Poll `pr_get_work_status` every 15s. For each newly completed file, update matching Task:
```
status = pr_get_work_status {}
For each file in status.completedFiles (not yet marked):
  TaskList → find task where subject.startsWith("PR {owner}/{repo}#{pr}: {file}")
  If found: TaskUpdate(taskId, status: "completed")
```

**Task updates by workers:** May not work in Claude Code 2.1 (background agent isolation), but try anyway - forward-compatible for future versions.

Decision on each poll:
- All partitions done (`pending === 0`) → proceed to **MCP final validation** (below)
- Any partition claimed >5 minutes with no heartbeat → stale worker, spawn replacement:
  ```
  Task(
    subagent_type="general-purpose",
    run_in_background=true,
    model="sonnet",
    description="PR replacement worker",
    prompt="Execute skill pr-review-worker.\n\nParameters:\n- agent_id: worker-replacement-{TIMESTAMP}\n- owner: ${OWNER}\n- repo: ${REPO}\n- pr: ${PR_NUMBER}\n- spawned_by_orchestrator: true\n\n[...same MCP bootstrap as Step 6...]"
  )
  ```
- Tasks still `pending` after all workers exited → spawn additional workers for remaining files

**Fallback (Step 5.5 failed / no Tasks found):**

Use `pr_get_work_status` polling every 30s (original behavior):
```
pr_get_work_status {}
```
Check `pendingFiles`, `completedFiles`, `failedFiles` until all files processed.

**MCP final validation (ALWAYS, regardless of monitoring method):**

When monitoring shows completion, make ONE final MCP call:
```
pr_get_work_status {}
```
- Confirms all partitions truly complete (`pendingFiles` empty)
- **If MCP disagrees with Tasks → trust MCP, continue monitoring**

**-> IMMEDIATELY proceed to Step 8 when done**

### Step 8: BUILD & TEST

**MANDATORY: Verify codebase builds and tests pass.**

**Detect project type by marker files:**

| Marker File | Project Type | Build Command | Test Command |
|-------------|--------------|---------------|--------------|
| `package.json` | Node.js/TS | `npm run build` | `npm test` |
| `*.csproj` / `*.sln` | .NET | `dotnet build` | `dotnet test` |
| `Cargo.toml` | Rust | `cargo build` | `cargo test` |
| `go.mod` | Go | `go build ./...` | `go test ./...` |
| `pyproject.toml` / `setup.py` | Python | `pip install -e .` | `pytest` |
| `Makefile` | Generic | `make` | `make test` |

**If build fails:**
1. Analyze error output
2. Spawn repair worker to fix:
   ```
   Task(
     subagent_type="general-purpose",
     run_in_background=false,
     model="sonnet",
     description="PR repair worker",
     prompt="Execute skill pr-review-worker.\n\nParameters:\n- agent_id: worker-repair\n- owner: ${OWNER}\n- repo: ${REPO}\n- pr: ${PR_NUMBER}\n- spawned_by_orchestrator: true\n\nFocus: Fix build errors reported below.\n[Include build error output]\n\n[...same MCP bootstrap as Step 6...]"
   )
   ```
3. Re-run build until success
4. **DO NOT proceed with broken build**

**If tests fail:**
- Caused by review changes -> fix it
- Pre-existing -> note in report, continue

**Re-review cycle (MANDATORY after workers push code):**

After build passes, check if agents need to re-review the pushed changes:
```
pr_get_work_status {}
```
- If `pendingAgents.length > 0` → agents are re-reviewing pushed changes → **Return to Step 5** (wait for them)
- If `pendingAgents.length === 0` → agents have finished, check for new comments:
  ```
  pr_summary { owner, repo, pr }
  ```
  - If `unresolved > 0` → new comments from re-review → **Return to Step 6** (spawn workers)
  - If `unresolved === 0` → all clear → **Proceed to Step 9**
- Max 3 re-review cycles total, then force proceed to Step 9

**-> Return to Step 5 (wait for re-review) OR Step 6 (new comments) OR proceed to Step 9**

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
pendingAgents.length === 0 AND unresolved === 0 AND build passes AND tests pass
```

ALL must be true simultaneously. Use `pr_get_work_status` to check `pendingAgents` and `isFullyComplete`.

| Condition | How to check | Action |
|-----------|-------------|--------|
| `pendingAgents.length > 0` | `pr_get_work_status {}` | Wait 30s - agents still reviewing |
| `pendingAgents.length === 0, unresolved > 0` | `pr_summary {}` | Spawn workers (Step 6) |
| `pendingAgents.length === 0, unresolved === 0` | Both tools | Build & Test → Completion |
| `pause-ai-review` label | `pr_labels { action: "get" }` | **STOP** - User requested |
| PR closed/merged | Poll response | **STOP** - External action |
| Build fails | Build output | Fix errors, do NOT proceed |

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

## FORBIDDEN (Orchestrator)

```
MERGE/SAFETY:
X pr_merge - merging requires human approval
X Ignoring pause-ai-review label
X Exiting with unresolved comments
X Exiting with broken build

WORKER TOOLS (orchestrator must NOT use these):
X pr_list - workers only
X pr_get - workers only
X pr_resolve - workers only
X pr_claim_work - workers only
X Read - workers only
X Edit - workers only
X Write - workers only
X Grep - workers only

GH CLI PROHIBITION (CRITICAL):
X `gh pr view` - use mcp__pr__pr_summary
X `gh pr checks` - use mcp__pr__pr_poll_updates
X `gh pr comment` - use MCP tools
X `gh api` - use MCP tools
X ANY `gh` command for PR operations - ALL PR interactions via mcp__pr__* tools
  Bash is ONLY for: git remote, npm run build, npm test

TASK UI VIOLATIONS:
X Using TaskList as sole completion check (ALWAYS validate with pr_get_work_status)
X Trusting Task status over MCP status (MCP is source of truth)
X Blocking on TaskCreate/TaskUpdate failures (they are optional)
X Skipping MCP final validation in Step 7

WORKFLOW VIOLATIONS:
X Processing comments yourself (spawn workers!)
X Running single-threaded (must spawn parallel workers)
X Spawning workers ONE BY ONE (must be parallel in single message)
X Skipping Step 6 when unresolved > 0
X Not using model="sonnet" for workers
X Asking user "should I start?"
X Presenting summary and waiting for confirmation
X Exiting while pendingAgents.length > 0 (agents still reviewing)
X Skipping MCP bootstrap (Step 0)
```

**If you catch yourself using pr_list/pr_get/pr_resolve/Read/Edit — you are doing the WORKER's job. STOP and spawn workers instead.**

**If you catch yourself using `gh` CLI via Bash — STOP. Load MCP tools via ToolSearch and use them instead.**

---

## Quick Start

```
Review PR #100
Review PR thebtf/novascript#42 with 5 workers
Process AI review comments for current PR
```
