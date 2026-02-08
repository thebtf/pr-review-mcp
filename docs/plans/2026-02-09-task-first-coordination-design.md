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

**Approach: Task-First** — Remove the MCP coordination layer entirely. Use Claude Code's Task system as the primary coordination mechanism. MCP server becomes a pure GitHub data provider.

## Architecture

### Before (Polling-based)

```
Orchestrator ──poll──> MCP Server (in-memory state) <──claim/report── Workers
                       CoordinationStateManager
                       pr_claim_work
                       pr_report_progress
                       pr_get_work_status
```

### After (Task-based)

```
Orchestrator ──TaskCreate──> Task System <──TaskUpdate── Workers
                 │                              │
                 └── pr_invoke ──> MCP Server <── pr_get/pr_resolve ──┘
                                  (data only)
```

## MCP Server Changes

### Remove (coordination layer)

| Tool | Replacement |
|------|-------------|
| `pr_claim_work` | Worker reads `TaskList`, claims via `TaskUpdate(in_progress)` |
| `pr_report_progress` | Worker calls `TaskUpdate(completed)` |
| `pr_get_work_status` | Orchestrator calls `TaskList` |
| `pr_reset_coordination` | Orchestrator calls `TaskUpdate(deleted)` per task |

### Remove files

- `src/tools/coordination.ts` (~300 lines)
- `src/coordination/state.ts` (~200 lines)
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

## Orchestrator Workflow (New)

```
Step 1: ESCAPE CHECK       pr_labels → check "pause-ai-review"
Step 2: LABEL              pr_labels → set "ai-review:active"
Step 3: INVOKE AGENTS      pr_invoke { agent: "all" }
Step 4: WAIT FOR AGENTS    pr_poll_updates loop (only remaining poll)
Step 5: PARTITION           pr_list → group by file → partitions[]
Step 6: CREATE TASKS       N x TaskCreate (one per file partition)
Step 7: SPAWN WORKERS      N x Task(run_in_background: true)
Step 8: MONITOR            TaskList loop until all completed (15s interval)
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

### Step 8: Monitoring

```
while (true) {
  tasks = TaskList()
  prTasks = tasks.filter(t => t.subject.startsWith("PR #"))
  completed = prTasks.filter(t => t.status === "completed").length
  failed = prTasks.filter(t => t.status === "in_progress" && age > 5min)

  if (completed + failed.length === prTasks.length) break
  if (failed.length > 0) spawn rescue workers

  log(`[${completed}/${prTasks.length}] partitions complete`)
  sleep(15s)
}
```

## Worker Protocol

### Claim-Loop Pattern

Workers dynamically claim tasks from the shared Task pool:

```
1. FIND WORK
   TaskList → find task with status: "pending" (lowest ID first)
   No pending tasks → EXIT (run build if changes made)

2. CLAIM
   TaskUpdate(taskId, status: "in_progress", owner: "worker-{N}")

3. PROCESS
   TaskGet(taskId) → read description (contains threadIds)
   For each threadId:
     pr_get({ owner, repo, pr, id: threadId }) → understand issue
     Edit/Write → fix code
     pr_resolve({ owner, repo, pr, threadId }) → close thread

4. COMPLETE
   TaskUpdate(taskId, status: "completed")

5. LOOP → Step 1
```

### Worker Prompt Template

```
# PR Review Worker

You are worker-{N} for PR #{pr} review. Work autonomously.

## Parameters
- owner: {OWNER}, repo: {REPO}, pr: {PR}
- worker_id: worker-{N}

## MCP Tools Available
- pr_get: Get full comment details
- pr_resolve: Mark thread as resolved

## Workflow

### Loop until no work remains:

1. **TaskList** → find task with `status: "pending"` whose subject
   starts with "PR #{pr}". Pick lowest ID first.
   - No pending tasks → run `npm run build` if you edited files, then EXIT.

2. **TaskUpdate(taskId, status: "in_progress", owner: "worker-{N}")**

3. **TaskGet(taskId)** → parse description JSON for file and threadIds.

4. For each threadId:
   a. `pr_get({ owner, repo, pr, id: threadId })` → read comment
   b. Understand the issue and fix the code
   c. `pr_resolve({ owner, repo, pr, threadId })` → close thread

5. **TaskUpdate(taskId, status: "completed")**

6. **LOOP** → back to step 1.

## Rules
- NO questions, NO confirmations
- Process ALL comments before marking complete
- If unsure about fix, make minimal safe change
- Before EXIT: run build if you modified any files
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

### Phase 1: Remove MCP coordination (MCP server)
1. Delete `src/tools/coordination.ts`
2. Delete `src/coordination/state.ts`
3. Remove tool registrations from `src/server.ts`
4. Update types if needed
5. Build and verify remaining tools work

### Phase 2: Rewrite skill (`/pr:review`)
1. Remove pr_claim_work, pr_report_progress, pr_get_work_status from worker prompts
2. Add TaskCreate/TaskUpdate/TaskList to orchestrator flow
3. Rewrite worker prompt with claim-loop pattern
4. Update monitoring loop to use TaskList

### Phase 3: Testing
1. Test on `thebtf/pr-review-mcp#2` (72+ comments)
2. Verify Task UI shows progress
3. Verify workers complete all tasks
4. Verify build passes after fixes

## Comparison

| Aspect | Before (MCP Coordination) | After (Task System) |
|--------|---------------------------|---------------------|
| Worker monitoring | `pr_get_work_status` polling loop (30s) | `TaskList` polling loop (15s) |
| Agent waiting | `pr_poll_updates` polling (30s) | Same (external agents) |
| Work distribution | `pr_claim_work` (in-memory atomic) | `TaskUpdate(in_progress)` (native) |
| Progress reporting | `pr_report_progress` (MCP call) | `TaskUpdate(completed)` (built-in) |
| Progress UI | Only orchestrator log | Native Task UI in Claude Code |
| State persistence | In-memory (lost on restart) | Task system (persistent) |
| Server code | ~500 lines coordination | 0 lines — removed |
| Stale detection | `cleanupStaleAgents` (5min) | Orchestrator checks task age |
| Re-queue failed | Automatic in state manager | Orchestrator spawns rescue worker |
| Race conditions | JS event loop atomicity | Task system handles |

## Limitations

1. **External agent polling remains**: CodeRabbit/Gemini write to GitHub — no way to get push notifications without webhooks or Streamable HTTP
2. **Task system dependency**: If Claude Code changes Task API, skill breaks
3. **No MCP-only clients**: The coordination pattern requires Claude Code's Task system — won't work from other MCP clients

## Future Enhancements

- **Streamable HTTP transport**: Replace `pr_poll_updates` with SSE push notifications for external agent completion
- **GitHub webhooks**: Real-time agent completion detection
- **Task dependencies**: Use `blockedBy` for build-after-fix ordering
