# Structured Output Monitoring for PR Review Workers

**Date:** 2026-02-09
**Status:** Rejected
**Related:** [Hybrid Task-First Coordination](2026-02-09-task-first-coordination-design.md)

## Problem

The orchestrator currently polls `pr_get_work_status` (MCP) every 15 seconds to monitor worker progress. Each poll is an LLM-driven MCP round-trip that costs tokens. Task UI updates are delayed by the polling interval.

**Goals:**
1. Reduce token consumption by eliminating MCP polling loop
2. Faster Task UI updates (react to worker output as it appears)

## Decision

**Approach: Structured Output Parsing** — Workers output progress tags as plain text. Orchestrator reads worker output via `TaskOutput(task_id, block=false)` and parses tags to update Task UI. MCP `pr_get_work_status` called **once** at the end for final validation.

## Architecture

### Before (MCP polling loop)

```
Orchestrator → pr_get_work_status (MCP) → parse JSON → TaskUpdate
              ↑ repeat every 15s ↑
```

Each cycle: 1 MCP call + 1 TaskList + N TaskUpdate ≈ ~200 tokens × 20-40 cycles.

### After (event-driven output parsing)

```
Workers → structured text output → output files
                                      ↑
Orchestrator → TaskOutput(block=false) per worker → parse tags → TaskUpdate
              ↑ repeat every 10s ↑

When all partitions [DONE]:
  ONE pr_get_work_status → final validation
```

Each cycle: N TaskOutput (local, ~50 tokens each) + M TaskUpdate. MCP called **once** at the end.

## Worker Output Protocol

Workers output progress tags as plain text alongside their normal operation. Tags are **mandatory** — unlike TaskUpdate which was optional.

### Tag Definitions

| Tag | When | Example |
|-----|------|---------|
| `[CLAIMED]` | After `pr_claim_work` → `claimed` | `[CLAIMED] src/app.ts (3 comments)` |
| `[RESOLVING]` | Before working on a thread | `[RESOLVING] src/app.ts: thread-abc` |
| `[RESOLVED]` | After `pr_resolve` | `[RESOLVED] src/app.ts: thread-abc` |
| `[SKIPPED]` | Thread cannot be processed | `[SKIPPED] src/app.ts: thread-xyz (ambiguous)` |
| `[DONE]` | After `pr_report_progress` | `[DONE] src/app.ts (3/3 resolved, 0 errors)` |
| `[BUILD]` | After final build | `[BUILD] pass` or `[BUILD] fail` |
| `[EXIT]` | Worker terminating | `[EXIT]` |

### Rules

- Tags are **mandatory** in worker output (unlike TaskUpdate which was optional)
- Each tag on its own line
- Workers output tags as regular text (not tool calls) — practically free in tokens
- MCP calls (`pr_claim_work`, `pr_report_progress`) remain — tags duplicate but don't replace
- If worker forgets tags → orchestrator detects via timeout (fallback)
- **Minimum sufficient set:** Orchestrator only needs `[DONE]` and `[EXIT]`. Other tags are for granular UI.

### Example Worker Output

```
[CLAIMED] src/app.ts (3 comments)
[RESOLVING] src/app.ts: thread-abc123
... (tool calls, code analysis) ...
[RESOLVED] src/app.ts: thread-abc123
[RESOLVING] src/app.ts: thread-def456
... (tool calls, code fixes) ...
[RESOLVED] src/app.ts: thread-def456
[RESOLVING] src/app.ts: thread-ghi789
... (tool calls) ...
[RESOLVED] src/app.ts: thread-ghi789
[DONE] src/app.ts (3/3 resolved, 0 errors)
[CLAIMED] src/utils.ts (2 comments)
...
[DONE] src/utils.ts (2/2 resolved, 0 errors)
[BUILD] pass
[EXIT]
```

## Orchestrator Monitoring (New Step 7)

```
workerTaskIds = [id1, id2, ...]  // from Task(run_in_background=true)
completedFiles = Set()
exitedWorkers = Set()
maxIterations = 60  // 10s × 60 = 10 minutes

for (iter = 0; iter < maxIterations; iter++):
  for each taskId in workerTaskIds:
    if taskId in exitedWorkers: skip

    output = TaskOutput(taskId, block=false)  // non-blocking read

    // Parse new [DONE] lines
    for each "[DONE] {file}" in output:
      if file not in completedFiles:
        completedFiles.add(file)
        // Find matching partition Task, mark completed
        TaskList → find "PR {owner}/{repo}#{pr}: {file}"
        TaskUpdate(taskId, status: "completed")

    // Detect worker exit
    if "[EXIT]" in output:
      exitedWorkers.add(taskId)

  // Check completion
  if exitedWorkers.size === workerTaskIds.length:
    break  // All workers done

  wait 10s

// MCP FINAL VALIDATION (ONE call)
status = pr_get_work_status()
if status.pendingFiles.length > 0:
  // Workers missed something — spawn rescue worker
```

### Key Differences from Current Approach

1. **No MCP polling loop** — saves ~40 MCP calls for a typical PR
2. **TaskOutput is local** — no network round-trip to MCP server
3. **Granular UI** — can update Task activeForm: `"Reviewing src/app.ts (2/3 resolved)"`
4. **Exit detection** — `[EXIT]` tag vs MCP state, react instantly
5. **One final MCP** — `pr_get_work_status` as safety net only

## Error Handling

| Scenario | Detection | Action |
|----------|-----------|--------|
| Worker crashed without `[EXIT]` | `TaskOutput` returns completed status without `[EXIT]` tag | Use `pr_get_work_status` to find unfinished partitions, spawn rescue worker |
| Worker hung (no new output 5+ min) | Compare output length between iterations — not growing | Spawn replacement worker |
| `TaskOutput` unavailable | Tool call fails | Fallback to `pr_get_work_status` polling (current behavior) |
| Worker doesn't output tags | No `[CLAIMED]`/`[DONE]` in output | Timeout → MCP fallback validation |
| MCP final validation mismatch | `pr_get_work_status` shows pending files, but output parsing showed all `[DONE]` | Trust MCP, spawn rescue worker |

### Stale Detection (Improved)

- **Current:** "partition claimed >5min" based on MCP data
- **New:** "no new output >5min" — more accurate, as we see real worker activity, not just MCP heartbeats

### Graceful Degradation

If `TaskOutput` doesn't work, orchestrator falls back to current MCP polling loop. This is ensured by the fallback section in Step 7.

## Scope of Changes

### Modified Files (skill-only, zero TypeScript)

| File | Change |
|------|--------|
| `claude/skills/pr-review/SKILL.md` | Rewrite Step 7: MCP polling → TaskOutput parsing |
| `claude/skills/pr-review-worker/SKILL.md` | Add output protocol (tags) to Workflow section |
| `src/prompts/review.ts` | Sync `ORCHESTRATOR_WORKFLOW` and worker prompt template |

### Unchanged

- MCP server (TypeScript code) — zero changes
- Worker MCP calls (`pr_claim_work`, `pr_report_progress`) — remain
- Step 5.5 (TaskCreate per file) — no changes
- Step 0.1 (orchestrator step Tasks) — no changes
- FORBIDDEN section — update only Step 7 related rules

### Estimated Size

~80 lines of changes in prompt/skill files.

## Token Analysis

Typical PR (30 comments, 3 workers, ~5 min):

| | Current (MCP polling) | Proposed (Output parsing) | Delta |
|---|---|---|---|
| Orchestrator: `pr_get_work_status` (15s × 20) | 2,000 | 200 (1 final) | -1,800 |
| Orchestrator: `TaskOutput` (10s × 30, 3 workers) | 0 | 1,500 | +1,500 |
| Orchestrator: `TaskList` + `TaskUpdate` | 1,000 | 500 | -500 |
| **Total monitoring** | **3,000** | **2,200** | **-800** |

Net savings: ~800 tokens per PR + faster UI response (10s vs 15s + MCP latency).

## Rejection Rationale (2026-02-09)

**Plan rejected after PAL challenge and TaskOutput research.**

### Fatal Flaws

1. **Output growth (KILLER):** `TaskOutput` returns the FULL output of background subagents — not just text, but **complete JSONL conversation logs** (all messages, tool calls, intermediate steps). A 5-minute worker session produces 200KB+ of JSONL. Reading this every 10s for 3 workers = ~18MB of tokens processed. Current MCP polling: 30 calls × 200 tokens = 6KB. **Ratio: ~3000x more expensive.**

2. **No incremental read:** `TaskOutput` has no offset/limit/tail parameters. No way to read only new output. Each read returns everything from the start.

3. **JSONL format:** For background subagents, `TaskOutput` returns JSONL conversation log, not clean text. Parsing structured tags from JSONL is fragile and token-expensive.

4. **Hanging issues:** GitHub issue #20236 reports `TaskOutput` hangs after background agent completion.

5. **LLM unreliability for tags:** Workers are LLM agents — they may forget, malformat, or prematurely output tags. No enforcement mechanism exists.

6. **Token analysis was wrong:** Original analysis assumed TaskOutput returns ~50 tokens per read. Actual cost: full JSONL log = thousands to tens of thousands of tokens per read.

### Conclusion

Current MCP polling (`pr_get_work_status` every 15s) is **optimal**: compact JSON response (~200 tokens), deterministic, battle-tested. No change needed.

### Future Reconsideration

Revisit if Claude Code adds:
- `TaskOutput` with offset/limit parameters (incremental read)
- Streaming/event-based notification for background task progress
- Compact final-result-only mode for `TaskOutput` (GitHub issue #16789)
