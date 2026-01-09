---
name: pr-review-worker
description: |
  Process claimed PR review partitions. Claims file, fixes comments, resolves threads.
  Triggers: "worker", "claim partition", "process partition"
context: fork
agent: background
model: sonnet
allowed-tools:
  - Read
  - Edit
  - Write
  - Glob
  - Grep
  - Bash
  - mcp__pr-review__pr_claim_work
  - mcp__pr-review__pr_list
  - mcp__pr-review__pr_get
  - mcp__pr-review__pr_resolve
  - mcp__pr-review__pr_report_progress
# NOTE: pr_labels is NOT allowed - only orchestrator manages labels
---

# PR Review Worker

Use this skill to claim file partitions and resolve their review comments.
Each partition contains a file path and a list of thread IDs.

## Inputs
- agent_id (unique per worker, e.g., "worker-1")
- owner, repo, pr (needed on first claim to initialize the run)

## Workflow
1. CLAIM: call pr_claim_work with agent_id and pr_info on first attempt.
2. PROCESS: for each thread id in partition.comments:
   - pr_get to fetch details and aiPrompt (if present).
   - Apply the fix, verify locally, then pr_resolve with threadId.
3. REPORT: pr_report_progress with status and counts for the file.
4. REPEAT: claim another partition until status=no_work.

## Handling Qodo comments
pr_get may return canResolve=false for Qodo.
pr_resolve accepts threadId values starting with "qodo-" and handles tracker updates.

## Example tool calls
```json
{"tool":"pr_claim_work","input":{"agent_id":"worker-1","pr_info":{"owner":"ORG","repo":"REPO","pr":123}}}
```

```json
{"tool":"pr_get","input":{"owner":"ORG","repo":"REPO","pr":123,"id":"THREAD_OR_COMMENT_ID"}}
```

```json
{"tool":"pr_resolve","input":{"owner":"ORG","repo":"REPO","pr":123,"threadId":"THREAD_ID_OR_QODO_ID"}}
```

```json
{"tool":"pr_report_progress","input":{"agent_id":"worker-1","file":"src/app.ts","status":"done","result":{"commentsProcessed":4,"commentsResolved":3,"errors":[]}}}
```

## Notes
- Use threadId from pr_get for pr_resolve.
- If aiPrompt is missing, follow the comment body and repo conventions.
- If pr_claim_work returns status=no_work, stop or back off before retrying.

## FORBIDDEN
- **NO LABELS** — workers must NOT set/remove labels. Only orchestrator manages labels.
- **NO MERGE** — workers never call pr_merge.
- **NO INVOKE** — workers don't invoke other review agents.
