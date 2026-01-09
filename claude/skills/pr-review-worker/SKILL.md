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
  - LSP
# NOTE: pr_labels is NOT allowed - only orchestrator manages labels
---

# PR Review Worker

**HANDOFF:** This worker is spawned by pr-review-orchestrator. Begin workflow IMMEDIATELY with the parameters provided in the spawn prompt.

Use this skill to claim file partitions and resolve their review comments.
Each partition contains a file path and a list of thread IDs.

## Inputs
- agent_id (unique per worker, e.g., "worker-1")
- owner, repo, pr (needed on first claim to initialize the run)

## Workflow
1. **CLAIM (FIRST ACTION):** Call pr_claim_work IMMEDIATELY with agent_id and pr_info.
   - First claim: include `pr_info: {owner, repo, pr}` to initialize the run
   - Subsequent claims: omit pr_info (run already initialized)
2. **PROCESS:** For each thread id in partition.comments:
   - **READ:** Call `Read` on the partition file path first
   - **FETCH:** pr_get to fetch details and aiPrompt (if present)
   - Apply the fix, verify locally, then pr_resolve with threadId
3. **REPORT:** pr_report_progress with status and counts for the file.
4. **REPEAT:** Claim another partition until status=no_work.
   - **BACKOFF POLICY:** If status=no_work, wait 30s and retry once. After 2 consecutive no_work responses, EXIT gracefully.

### 2b. CONFIDENCE LAYER (One-Hop Investigation)

After pr_get, before applying fix, classify the comment:

**CLASSIFY** comment body for trigger keywords:

| Category | Keywords | Action |
|----------|----------|--------|
| ALWAYS | security, injection, XSS, auth, sanitize, race, deadlock, null, undefined, leak, error, exception | Full investigation |
| CONDITIONAL | type, interface, performance, pattern, refactor | Light investigation |
| NEVER | formatting, style, naming, typo, comment, whitespace | Skip investigation |

**IF ALWAYS (full investigation):**
1. Read full affected file
2. Grep for direct callers: `Grep pattern="functionName" path="src/" output_mode="content" -C=3`
3. LSP goToDefinition if external call present
4. Analyze: "Is there a deeper issue behind this comment?"

**IF CONDITIONAL (light investigation):**
1. Read ±50 lines around the change
2. Quick analysis: obvious deeper issue?

**IF deeper issue found:**
Append to `.agent/status/TECHNICAL_DEBT.md`:
```markdown
## [DATE] <file>:<line>

**Comment:** <reviewer's comment summary>
**Deeper issue:** <what you discovered>
**Root cause:** <analysis of why this exists>
**Category:** security | performance | architecture | error-handling
```

Continue with original fix - do NOT block on tech debt discovery.

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
- **NO BLOCKING on tech debt** — record and continue with the fix
