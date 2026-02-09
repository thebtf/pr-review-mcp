# Task-First Coordination Design

**Date:** 2026-02-09
**Status:** Approved
**Scope:** Replace MCP coordination layer with Claude Code Task system

## Problem

The current `/pr:review` orchestrator uses polling loops for worker monitoring:

1. **Agent polling**: `pr_poll_updates` every 30s to check if CodeRabbit/Gemini/Codex finished
2. **Worker polling**: `pr_get_work_status` every 30s to check if workers completed partitions

Both loops waste context tokens and add latency. Claude Code now provides a native Task system (`TaskCreate/TaskUpdate/TaskList`) that subagents can use directly, eliminating the need for custom MCP coordination tools.

## Decision

**Approach: Task-First (Hybrid)** — Use Claude Code's Task system for primary coordination and UI monitoring, while keeping MCP as the authoritative source of truth and fallback layer. The MCP coordination tools (`pr_claim_work`, `pr_report_progress`, `pr_get_work_status`) remain for:
- Source of truth validation (orchestrator always validates with `pr_get_work_status` after Task monitoring)
- Fallback coordination if Task system unavailable
- Atomic partition claiming to prevent race conditions

MCP server provides both coordination primitives and GitHub data access.

## Architecture

### Before (Polling-based)

```
Orchestrator ──poll──> MCP Server (in-memory state) <──claim/report── Workers
                       CoordinationStateManager
                       pr_claim_work
                       pr_report_progress
                       pr_get_work_status
```

### After (Hybrid: Task + MCP)

```
Orchestrator ──TaskCreate──> Task System <──TaskUpdate── Workers
    │            (UI/monitoring)                  │
    │                                             │
    ├─── pr_get_work_status ──> MCP Server <──── pr_claim_work ────┤
    │         (validation)      (coordination    (atomic claiming)  │
    │                            + data)                             │
    └── pr_invoke/pr_labels ───────────┘<─── pr_get/pr_resolve ─────┘
```

## MCP Server Changes

### Keep (coordination layer - MCP as source of truth)

| Tool | Primary Use | Task System Supplement |
|------|-------------|------------------------|
| `pr_claim_work` | Atomic partition claiming (prevents races) | Worker also calls `TaskUpdate(in_progress)` for UI |
| `pr_report_progress` | Authoritative completion tracking | Worker also calls `TaskUpdate(completed)` for UI |
| `pr_get_work_status` | **Final validation** by orchestrator | Orchestrator primarily monitors via `TaskList`, but ALWAYS validates with this before completion |
| `pr_reset_coordination` | Reset stale MCP state | Orchestrator may also clean up stale Tasks |

**Rationale:** MCP coordination tools remain because:
- `pr_claim_work` provides atomic partition claiming (Task system doesn't guarantee atomicity)
- `pr_get_work_status` is the source of truth for completion (Task status is display-only)
- Fallback when Task system unavailable or after context compaction

### Files retained

- `src/tools/coordination.ts` (coordination tools)
- `src/coordination/state.ts` (state manager)
- Related tests

### Keep (data provider)

| Tool | Purpose |
|------|---------|
| `pr_summary` | PR statistics |
| `pr_list` | Comments with filtering |
| `pr_get` | Full comment details + AI prompt |
| `pr_resolve` | Mark thread as resolved |
| `pr_invoke` | Invoke AI review agents |
| `pr_poll_updates` | External agent status (only remaining polling) |
| `pr_labels` | Label management |
| `pr_list_prs` | List open PRs |
| `pr_changes` | Incremental updates |

## Orchestrator Workflow (Hybrid)

```
Step 1: ESCAPE CHECK       pr_labels → check "pause-ai-review"
Step 2: PREFLIGHT          pr_get_work_status → check for active runs
Step 3: LABEL              pr_labels → set "ai-review:active"
Step 4: INVOKE AGENTS      pr_invoke { agent: "all" }
Step 5: WAIT FOR AGENTS    pr_poll_updates + pr_get_work_status loop
Step 6: CREATE TASKS       N x TaskCreate (one per file, for UI)
Step 7: SPAWN WORKERS      N x Task(run_in_background: true)
Step 8: MONITOR            TaskList loop (15s) + MCP FINAL VALIDATION
                           → When TaskList shows completion, call pr_get_work_status
                           → If MCP disagrees, trust MCP and continue monitoring
Step 9: BUILD & TEST       npm run build / go build / etc.
Step 10: COMPLETION        pr_labels → set "ai-review:passed"
```

### Step 6: Task Creation

For each file partition, orchestrator creates a task:

```
TaskCreate({
  subject: "PR #{pr}: Fix {file} ({count} comments)",
  description: JSON.stringify({
    owner, repo, pr,
    file: "src/utils.ts",
    threadIds: ["thread-123", "thread-456", "thread-789"],
    severity: "high"
  }),
  activeForm: "Fixing src/utils.ts"
})
```

### Step 7: Worker Spawning

All workers spawned in a single message for maximum parallelism:

```
Task({
  subagent_type: "general-purpose",
  run_in_background: true,
  model: "sonnet",
  prompt: workerPrompt({ owner, repo, pr, worker_id: "worker-1" })
})
// ... repeat for each worker
```

Worker count: `min(max_workers, max(1, ceil(total_tasks / 3)))`

### Step 8: Monitoring (Hybrid with MCP Final Validation)

```
while (true) {
  tasks = TaskList()
  prTasks = tasks.filter(t => t.subject.startsWith("PR #"))
  completed = prTasks.filter(t => t.status === "completed").length
  failed = prTasks.filter(t => t.status === "in_progress" && age > 5min)

  if (completed + failed.length === prTasks.length) {
    // MCP FINAL VALIDATION (MANDATORY)
    status = pr_get_work_status()
    if (status.pendingFiles.length === 0) {
      break  // Confirmed complete
    } else {
      log("Task UI shows complete but MCP has pending work - trusting MCP")
      continue  // Trust MCP, continue monitoring
    }
  }
  if (failed.length > 0) spawn rescue workers

  log(`[${completed}/${prTasks.length}] partitions complete`)
  sleep(15s)
}
```

**Critical: Always validate Task completion with `pr_get_work_status`. MCP is the source of truth.**

## Worker Protocol

### Claim-Loop Pattern (Hybrid: MCP + Task UI)

Workers use MCP for coordination and Task system for UI updates:

```
1. CLAIM (MCP - source of truth)
   pr_claim_work({ agent_id, pr_info }) → returns partition or no_work
   If no_work → run build if changes made, then EXIT

2. UPDATE TASK UI (optional, non-blocking)
   TaskList → find task matching partition.file
   TaskUpdate(taskId, status: "in_progress")
   (If Task UI fails, continue - MCP is source of truth)

3. PROCESS
   For each threadId in partition.comments:
     pr_get({ owner, repo, pr, id: threadId }) → understand issue
     Edit/Write → fix code
     pr_resolve({ owner, repo, pr, threadId }) → close thread

4. REPORT (MCP - source of truth)
   pr_report_progress({ agent_id, file, status: "done" })

5. UPDATE TASK UI (optional, non-blocking)
   TaskUpdate(taskId, status: "completed")

6. LOOP → Step 1
```

### Worker Prompt Template

```
# PR Review Worker

You are worker-{N} for PR #{pr} review. Work autonomously.

## Parameters
- owner: {OWNER}, repo: {REPO}, pr: {PR}
- agent_id: worker-{N}

## MCP Tools Available
- pr_claim_work: Claim file partition (atomic, source of truth)
- pr_get: Get full comment details
- pr_resolve: Mark thread as resolved
- pr_report_progress: Report completion (source of truth)

## Workflow

### Loop until no work remains:

1. **pr_claim_work({ agent_id, pr_info })** → returns partition or no_work
   - status: "claimed" → process the partition
   - status: "no_work" → run `npm run build` if you edited files, then EXIT

2. **TaskUpdate (optional, for UI)**: Find task matching partition.file via TaskList,
   update to `in_progress`. If fails, continue (MCP is source of truth).

3. For each threadId in partition.comments:
   a. `pr_get({ owner, repo, pr, id: threadId })` → read comment
   b. Understand the issue and fix the code
   c. `pr_resolve({ owner, repo, pr, threadId })` → close thread

4. **pr_report_progress({ agent_id, file, status: "done" })**

5. **TaskUpdate (optional, for UI)**: Update task to `completed`

6. **LOOP** → back to step 1.

## Rules
- NO questions, NO confirmations
- Process ALL comments in partition before reporting
- If unsure about fix, make minimal safe change
- Before EXIT: run build if you modified any files
- Task UI updates are optional - if they fail, continue with MCP workflow
```

## Error Handling

| Scenario | Detection | Resolution |
|----------|-----------|------------|
| Worker hangs | Task `in_progress` > 5 min | Orchestrator spawns rescue worker |
| Worker crash | Background agent returns error | Orchestrator re-spawns for uncompleted tasks |
| Race condition | Two workers claim same task | First `TaskUpdate(in_progress)` wins; second sees status != pending, skips |
| Build fails | `npm run build` exits non-zero | Orchestrator spawns repair worker with error |
| New comments | Post-worker `pr_list` finds new threads | Orchestrator creates additional tasks, spawns more workers |
| PR closed | Label check in monitoring loop | Orchestrator stops, cleans up tasks |

## Migration Plan

### Phase 1: Add Task UI layer (MCP server - NO CHANGES)
1. Keep `src/tools/coordination.ts` (MCP coordination remains)
2. Keep `src/coordination/state.ts` (source of truth)
3. MCP server is unchanged - hybrid approach uses existing tools

### Phase 2: Enhance skills with Task UI (`/pr:review`)
1. Keep pr_claim_work, pr_report_progress, pr_get_work_status in worker prompts (MCP coordination)
2. Add TaskCreate/TaskUpdate/TaskList for UI monitoring
3. Update orchestrator monitoring to use TaskList with MCP final validation
4. Update worker prompts to optionally update Task UI (non-blocking)

### Phase 3: Testing
1. Test on `thebtf/pr-review-mcp#2` (72+ comments)
2. Verify Task UI shows progress (UI layer)
3. Verify MCP coordination works (source of truth)
4. Verify pr_get_work_status final validation catches Task/MCP discrepancies
5. Verify workers complete all tasks
6. Verify build passes after fixes

## Comparison

| Aspect | Before (MCP Only) | After (Hybrid: Task + MCP) |
|--------|-------------------|----------------------------|
| Worker monitoring | `pr_get_work_status` polling (30s) | `TaskList` polling (15s) + `pr_get_work_status` final validation |
| Agent waiting | `pr_poll_updates` polling (30s) | Same (external agents) |
| Work distribution | `pr_claim_work` (atomic) | Same (MCP remains for atomicity) |
| Progress reporting | `pr_report_progress` (MCP) | Same (MCP remains source of truth) |
| Progress UI | Only orchestrator log | Native Task UI + MCP coordination |
| State persistence | In-memory (lost on restart) | Dual: MCP (in-memory) + Task system (persistent) |
| Server code | ~500 lines coordination | Same (~500 lines - retained) |
| Stale detection | `cleanupStaleAgents` (5min) | Hybrid: Orchestrator checks Task age + MCP stale cleanup |
| Re-queue failed | Automatic in state manager | Same (MCP) + orchestrator spawns rescue workers |
| Race conditions | MCP atomic claiming | Same (MCP provides atomicity) |
| Final validation | `pr_get_work_status` only | `TaskList` primary + **MANDATORY** `pr_get_work_status` validation |

## Limitations

1. **External agent polling remains**: CodeRabbit/Gemini write to GitHub — no way to get push notifications without webhooks or Streamable HTTP
2. **Dual coordination overhead**: Maintaining both MCP and Task system adds complexity
3. **Task UI failures non-blocking**: Task updates are optional - if Task system fails, workflow continues via MCP
4. **MCP remains in-memory**: MCP coordination state still lost on server restart (Task system provides persistence for UI only)

## Future Enhancements

- **Streamable HTTP transport**: Replace `pr_poll_updates` with SSE push notifications for external agent completion
- **GitHub webhooks**: Real-time agent completion detection
- **Task dependencies**: Use `blockedBy` for build-after-fix ordering
