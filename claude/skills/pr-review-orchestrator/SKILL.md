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
  - mcp__pr-review__pr_summary
  - mcp__pr-review__pr_get_work_status
  - mcp__pr-review__pr_labels
---

# PR Review Orchestrator

Use this skill to coordinate parallel workers that resolve PR review comments.
It prepares partitions conceptually by severity/file, spawns workers, monitors progress,
handles stale claims, aggregates results, and updates PR labels.

## Inputs
- owner, repo, pr
- desired_workers (3-5)
- agent_id_prefix (e.g., "worker")

## Workflow
1. **PREFLIGHT CHECK**: Call pr_get_work_status first.
   - If `isActive === true` AND `runAge < 300000` (5 min): **ABORT** — another orchestrator is running.
   - If `isActive === true` AND `runAge >= 300000`: Stale run. Clean up labels and proceed.
2. **LABEL CLEANUP**: On startup, atomically set labels to remove any stale state:
   - Use `pr_labels` with `action: "set"` and `labels: ["ai-review:active"]`
   - This replaces ALL labels atomically, removing `ai-review:partial` or `ai-review:complete` if present.
3. **INIT**: Call pr_summary to understand scope and hotspots by severity/file.
4. **SPAWN**: Start 3-5 workers with Task(run_in_background=true, model="sonnet").
   - IMPORTANT: Always use model="sonnet" for background workers to avoid wasting opus tokens.
   - Ensure the first worker call includes pr_info to initialize the run.
5. **MONITOR**: Poll pr_get_work_status every 30s until all partitions are done/failed.
6. **AGGREGATE**: Compile per-file results from work status and worker reports.
7. **FINAL LABELS**: Atomically set final state:
   - If all partitions succeeded: `pr_labels` action="set" labels=["ai-review:complete"]
   - If some failed: `pr_labels` action="set" labels=["ai-review:partial"]

## Partitioning model
Actual partitions are created when a worker calls pr_claim_work with pr_info.
Partitions are grouped by file and severity based on unresolved threads.
See D:/Dev/pr-review-mcp/src/tools/coordination.ts for grouping logic.

## Stale claims handling
Workers are considered stale after 5 minutes without activity.
On the next pr_claim_work call, stale claimed files are re-queued.
See D:/Dev/pr-review-mcp/src/coordination/state.ts (cleanupStaleAgents).
If pr_get_work_status shows old lastSeen values, spawn a replacement worker.

## Example tool calls

### Step 1: Preflight check
```json
{"tool":"pr_get_work_status","input":{}}
```
Response fields: `isActive`, `runAge` — if isActive && runAge < 300000, abort.

### Step 2: Atomic label cleanup
```json
{"tool":"pr_labels","input":{"owner":"ORG","repo":"REPO","pr":123,"action":"set","labels":["ai-review:active"]}}
```

### Step 3: Get summary
```json
{"tool":"pr_summary","input":{"owner":"ORG","repo":"REPO","pr":123}}
```

### Step 4: Spawn workers
```text
Task({
  subagent_type: "general-purpose",
  run_in_background: true,
  model: "sonnet",
  prompt: "Use skill pr-review-worker. agent_id=worker-1. owner=ORG repo=REPO pr=123"
})
```

### Step 5: Monitor progress
```json
{"tool":"pr_get_work_status","input":{}}
```

### Step 7: Final labels (atomic set)
```json
{"tool":"pr_labels","input":{"owner":"ORG","repo":"REPO","pr":123,"action":"set","labels":["ai-review:complete"]}}
```

## Output
- Return a concise summary of resolved/failed counts by file and severity.
- If no MCP comment tool is available, return the summary to the caller for posting.
