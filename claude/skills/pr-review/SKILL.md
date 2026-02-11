---
name: pr-review
description: |
  Autonomous PR review orchestrator with real-time progress monitoring. Spawns parallel workers to process all AI review comments.
  Shows live progress updates in TaskList. For silent background execution, use pr-review-background.

  Triggers: "review PR", "PR review", "process comments", "AI review", "orchestrate review"
context: fork
agent: foreground
model: sonnet
allowed-tools:
  - Task
  - TaskCreate
  - TaskUpdate
  - TaskList
  - Bash
  - ToolSearch
  - mcp__pr__pr_progress_check
  - mcp__pr__pr_get_work_status
  - mcp__pr__pr_summary
---

# PR Review with Monitoring

Launches pr-review orchestrator in background and monitors progress, updating TaskList for visibility.

---

## EXECUTION MODE

**Semi-autonomous with progress reporting.**

1. Launch orchestrator in background
2. Create tasks for each orchestrator phase
3. Poll progress every 15s
4. Update tasks as orchestrator progresses
5. Report completion summary

---

## WORKFLOW

### Step 0: Create Progress Tasks

Create task structure for monitoring:

```
tasks = [
  TaskCreate({
    subject: "Preflight checks",
    description: "Validate PR state, check for conflicting orchestrators",
    activeForm: "Running preflight checks"
  }),
  TaskCreate({
    subject: "Invoke AI agents",
    description: "Trigger CodeRabbit, Gemini, Codex reviews",
    activeForm: "Invoking AI review agents"
  }),
  TaskCreate({
    subject: "Wait for agent reviews",
    description: "Poll until all agents complete their reviews",
    activeForm: "Waiting for AI agents to complete"
  }),
  TaskCreate({
    subject: "Process review comments",
    description: "Spawn workers to fix all unresolved comments",
    activeForm: "Processing review comments"
  }),
  TaskCreate({
    subject: "Run build and tests",
    description: "Validate changes don't break build or tests",
    activeForm: "Running build and tests"
  })
]
```

Map orchestrator phases to task IDs:
```javascript
const phaseToTask = {
  'escape_check': tasks[0],
  'preflight': tasks[0],
  'label': tasks[0],
  'invoke_agents': tasks[1],
  'poll_wait': tasks[2],
  'spawn_workers': tasks[3],
  'monitor': tasks[3],
  'build_test': tasks[4],
  'complete': null, // All done
  'error': null,
  'aborted': null
};
```

**-> IMMEDIATELY proceed to Step 1**

### Step 1: Launch Orchestrator

**Load MCP tool first:**
```
ToolSearch query: "select:mcp__pr__pr_progress_check"
```

**Launch orchestrator in background:**
```
Task(
  subagent_type="general-purpose",
  description="PR review orchestrator",
  prompt="Use /pr-review skill for PR #{pr}",
  run_in_background=true,
  model="sonnet"
)
```

**Capture agent ID** from tool result for status checking.

**-> IMMEDIATELY proceed to Step 2**

### Step 2: Monitor Progress Loop

**Max iterations: 80 (15s × 80 = 20 minutes total timeout)**

Each iteration:

1. **Poll orchestrator status:**
```
status = mcp__pr__pr_progress_check()
```

2. **Update task based on current phase:**
```javascript
if (status.orchestrator) {
  const phase = status.orchestrator.currentPhase;
  const taskId = phaseToTask[phase];

  if (taskId && currentTaskId !== taskId) {
    // Complete previous task
    if (currentTaskId) {
      TaskUpdate(currentTaskId, status: "completed");
    }

    // Start new task
    TaskUpdate(taskId, status: "in_progress");
    currentTaskId = taskId;
  }
}
```

3. **Check for completion:**
```javascript
if (!status.run.active) {
  // Orchestrator finished
  break;
}
```

4. **Wait 15s before next poll:**
```
Bash: sleep 15
```

**Special cases:**
- `phase: "error"` or `phase: "aborted"` → mark current task as failed, stop loop
- `phase: "complete"` → mark all tasks as completed, stop loop
- Timeout (80 iterations) → report timeout, stop loop

**-> IMMEDIATELY proceed to Step 3**

### Step 3: Final Status & Summary

**Complete any remaining tasks:**
```
TaskList → mark any "in_progress" tasks as "completed"
```

**Get final work status:**
```
finalStatus = mcp__pr__pr_get_work_status()
```

**Get PR summary:**
```
summary = mcp__pr__pr_summary({ owner, repo, pr })
```

**Report to user:**
```
PR #{pr} review completed!

Final status:
- Completed files: {completedFiles.length}
- Failed files: {failedFiles.length}
- Unresolved comments: {summary.unresolved}

{failedFiles.length > 0 ? "⚠️ Some files failed - see orchestrator output" : "✅ All files processed"}
{summary.unresolved > 0 ? "⚠️ Unresolved comments remain" : "✅ All comments resolved"}
```

**-> DONE**

---

## MONITORING OPTIONS

### Sync Mode (Optional)

If user requests synchronous execution:
- Use `run_in_background=false` in Task call
- Skip Step 2 (no monitoring needed - foreground agent blocks)
- Proceed directly to Step 3 after orchestrator completes

Trigger words: "synchronous", "wait for completion", "foreground", "blocking"

### Silent Mode (Redirect to pr-review)

If user wants no progress updates:
```
User: "Review PR #5 silently in background"

Response: "Launching silent background review. Use /pr-review skill directly for this - it runs without progress updates."

[Don't use this skill - use pr-review instead]
```

---

## ERROR HANDLING

| Error | Action |
|-------|--------|
| `mcp__pr__pr_progress_check` not available | Report: "MCP progress bus not available. Use /pr-review for silent background execution." |
| Orchestrator task launch fails | Report error, do not proceed to monitoring |
| Orchestrator aborts (escape check) | Mark current task as completed, report: "Review aborted - pause-ai-review label present" |
| Orchestrator errors out | Mark current task as failed, report error detail from `status.orchestrator.detail` |
| Timeout (20 min) | Report: "Orchestrator timeout after 20 minutes. Check orchestrator output for details." |

---

## ARCHITECTURE NOTES

**Why this skill exists:**

Background agents (Claude Code 2.1) cannot update parent TaskList due to platform isolation. This skill bridges the gap by:
1. Running orchestrator in background (efficient, no context pollution)
2. Polling MCP progress bus (Phase 4 feature)
3. Updating parent TaskList based on orchestrator phases

**When background agents gain TaskList access** (future Claude Code versions), orchestrator can update tasks directly and this skill becomes optional (for users who prefer explicit monitoring control).

**Design principle:** Forward-compatible. Orchestrator attempts TaskUpdate (if API allows), and this skill provides fallback polling for current platform.
