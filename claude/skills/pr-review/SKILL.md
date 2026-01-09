---
name: pr-review
description: |
  Autonomous multi-agent PR review orchestrator. Processes all AI review comments until PR is ready for merge.
  Supports CodeRabbit, Gemini, Codex, Sourcery, Qodo, Copilot agents.

  Triggers: "review PR", "PR review", "process comments", "AI review", "review cycle"
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
  - mcp__pr-review__pr_summary
  - mcp__pr-review__pr_list
  - mcp__pr-review__pr_get
  - mcp__pr-review__pr_resolve
  - mcp__pr-review__pr_changes
  - mcp__pr-review__pr_invoke
  - mcp__pr-review__pr_poll_updates
  - mcp__pr-review__pr_labels
  - mcp__pr-review__pr_reviewers
  - mcp__pr-review__pr_create
  - mcp__pr-review__pr_merge
  - mcp__pr-review__pr_review_cycle
---

# Autonomous PR Review Skill

Multi-agent PR review orchestrator. Runs as background agent until all comments are resolved.

---

## CRITICAL SAFETY RULES

| Rule | Enforcement |
|------|-------------|
| **NO AUTO-MERGE** | NEVER call `pr_merge`. Report readiness only. |
| **HUMAN GATE** | All merges require explicit user approval |
| **ESCAPE HATCH** | Stop immediately if `pause-ai-review` label present |
| **FIX ALL** | Process ALL comments regardless of severity. No skipping. |
| **OUT OF SCOPE** | Never dismiss as "out of scope" without action. See below. |

---

## State Machine

```
INIT → CHECK_ESCAPE → INVOKE_AGENTS → POLL_WAIT
                                         ↓
                    ┌────────────────────┴────────────────────┐
                    │                                         │
              allAgentsReady?                           pause label?
                    │                                         │
              ┌─────┴─────┐                              STOP (user)
              no          yes
              ↓            ↓
           (wait)    unresolved > 0?
                          │
                    ┌─────┴─────┐
                    yes         no
                    ↓            ↓
             PROCESS_COMMENTS  SUCCESS → READY_REPORT
                    │
                    ↓
             (fixes pushed)
                    │
                    └──→ POLL_WAIT (re-review cycle)
```

---

## Workflow Phases

### Phase 1: Initialization

```
1. Parse PR context: { owner, repo, pr }
2. Set label: ai-review:active
3. Initialize: round = 0, startTime = now()
```

### Phase 2: Escape Check (EVERY ITERATION)

```
1. Check pause label:
   - If 'pause-ai-review' present → STOP, report "Paused by user"

2. Check PR state:
   - If closed/merged → STOP, report "PR closed externally"
```

### Phase 3: Review Cycle

```
1. Configure (first run):
   - mode: sequential | parallel | round-robin
   - agents: [coderabbit, gemini, codex, sourcery, qodo, copilot]

2. Start cycle → record timestamp for polling
```

### Phase 4: Poll & Wait

```
1. Poll every 30s: pr_poll_updates { include: ["comments", "agents"] }

2. Check agent status:
   - allAgentsReady: false → wait, agents still reviewing
   - pendingAgents: [...] → shows which agents not finished

3. If new commits → wait for re-review (agents will re-analyze)

4. If allAgentsReady: true AND has unresolved → proceed to Phase 5

5. If allAgentsReady: true AND unresolved === 0 → COMPLETE
```

### Phase 5: Process Comments

```
1. Get unresolved comments

2. For EACH comment (regardless of severity):
   a. Get full details + AI prompt
   b. Execute AI prompt literally
   c. Verify fix compiles
   d. Resolve thread

NO SKIPPING. Every comment must be fixed.

3. After all current comments resolved:
   → Return to Phase 4 (Poll & Wait)
   → Agents may re-review and add NEW comments
   → Loop continues until: allAgentsReady AND unresolved === 0
```

### Handling "Out of Scope" Comments

If a comment requires work beyond current PR scope:

```
1. ESTIMATE effort (lines of code, files affected, complexity)

2. If truly large (>1 day work, architectural change):
   a. Add entry to tech debt file (.agent/status/TECH_DEBT_PLAN.md):
      - Problem description
      - Affected files/components
      - Estimated effort
      - Link to original PR comment
   b. Reply to comment with tech debt reference
   c. THEN resolve thread

3. If small-medium (<1 day): just fix it in this PR

NEVER just say "out of scope" without adding tech debt entry.
```

### Phase 6: Advance & Loop

```
1. Advance to next agent (sequential/round-robin)
2. Check status: running | waiting | completed | stopped
3. Loop back to Phase 2
```

### Phase 7: Completion

```
1. Get final statistics
2. Set label: ai-review:passed | ai-review:needs-attention
3. Report to user (DO NOT MERGE):
   "PR Review Complete. Ready for human review."
```

---

## Convergence Conditions

**EXIT condition (success):**
```
allAgentsReady === true AND unresolved === 0
```

Both must be true simultaneously. After fixing comments, agents may re-review and add new comments.

| Condition | Action |
|-----------|--------|
| `allAgentsReady: false` | Wait — agents still reviewing |
| `allAgentsReady: true, unresolved > 0` | Process comments (Phase 5) |
| `allAgentsReady: true, unresolved === 0` | **SUCCESS** → Phase 7 |
| `pause-ai-review` label | **STOP** → User requested |
| PR closed/merged | **STOP** → External action |

---

## Label Convention

| Label | Meaning |
|-------|---------|
| `ai-review:active` | Review in progress |
| `ai-review:passed` | Ready for merge (0 unresolved) |
| `ai-review:needs-attention` | Has unresolved comments |
| `pause-ai-review` | **Escape hatch** — stops automation |

---

## Error Handling

| Error | Action |
|-------|--------|
| Tool call fails | Retry 3x with backoff |
| Agent timeout | Skip agent, continue |
| PR closed externally | Stop gracefully |
| Network error | Wait 60s, retry |
| Unknown error | Set `ai-review:error` label, stop |

---

## Progress Reporting

```markdown
### Review Cycle Update (Round N)

| Metric | Count |
|--------|-------|
| Resolved this round | X |
| Remaining | Y |
| Current agent | name |

Status: Processing...
```

---

## FORBIDDEN

```
❌ pr_merge — merging requires human approval
❌ Ignoring pause-ai-review label
❌ Marking ANY comment resolved without fixing
❌ Skipping comments (regardless of severity)
❌ "Complex, will defer later"
❌ "Trivial, can skip"
❌ "Out of scope" without tech debt entry
❌ Exiting with unresolved comments
❌ Force-push or destructive git ops
```

---

## Quick Start

```
Review PR owner/repo#123
Review PR owner/repo#42 with round-robin using coderabbit and sourcery
```
