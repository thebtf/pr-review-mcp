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
| **BUILD MUST PASS** | Never finish with broken build or failing tests. |
| **OUT OF SCOPE** | Never dismiss as "out of scope" without action. See below. |

---

## State Machine

```
INIT -> CHECK_ESCAPE -> INVOKE_AGENTS -> POLL_WAIT
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
             PROCESS_COMMENTS  BUILD_TEST -> SUCCESS -> READY_REPORT
                    |
                    v
             (fixes pushed)
                    |
                    v
              BUILD_TEST
                    |
                    +---> POLL_WAIT (re-review cycle)
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
   - If 'pause-ai-review' present -> STOP, report "Paused by user"

2. Check PR state:
   - If closed/merged -> STOP, report "PR closed externally"
```

### Phase 3: Review Cycle

```
1. Configure (first run):
   - mode: sequential | parallel | round-robin
   - agents: [coderabbit, gemini, codex, sourcery, qodo, copilot]

2. Start cycle -> record timestamp for polling
```

### Phase 4: Poll & Wait

```
1. Poll every 30s: pr_poll_updates { include: ["comments", "agents"] }

2. Check agent status:
   - allAgentsReady: false -> wait, agents still reviewing
   - pendingAgents: [...] -> shows which agents not finished

3. If new commits -> wait for re-review (agents will re-analyze)

4. If allAgentsReady: true AND has unresolved -> proceed to Phase 5

5. If allAgentsReady: true AND unresolved === 0 -> proceed to Phase 6 (Build & Test)
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
   -> Proceed to Phase 6 (Build & Test)
```

### Phase 6: BUILD & TEST (MANDATORY)

**Run after every round of fixes, before returning to poll or completing.**

```bash
# Detect project type and run build
npm run build   # Node.js/TypeScript
dotnet build    # .NET
cargo build     # Rust
go build ./...  # Go
```

**If build fails:**
1. Analyze error output
2. Fix compilation errors caused by your changes
3. Re-run build until success
4. **DO NOT proceed with broken build**

**Run tests:**
```bash
npm test        # or: dotnet test, cargo test, go test ./...
```

**If tests fail:**
1. Identify failing tests
2. If failure is caused by changes made during review -> fix it
3. If failure is pre-existing -> note in report, continue

**Then:**
- If more agents reviewing -> return to Phase 4 (Poll & Wait)
- If all agents done AND unresolved === 0 -> proceed to Phase 8 (Completion)

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

### Phase 7: Advance & Loop

```
1. Advance to next agent (sequential/round-robin)
2. Check status: running | waiting | completed | stopped
3. Loop back to Phase 2
```

### Phase 8: Completion

```
1. Run FINAL build and test verification
2. Get final statistics
3. Set label: ai-review:passed | ai-review:needs-attention
4. Report to user (DO NOT MERGE):
   "PR Review Complete. Build and tests passing. Ready for human review."
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
| `allAgentsReady: true, unresolved > 0` | Process comments (Phase 5) |
| `allAgentsReady: true, unresolved === 0` | Build & Test (Phase 6) -> Completion |
| `pause-ai-review` label | **STOP** - User requested |
| PR closed/merged | **STOP** - External action |
| Build fails | Fix errors, do NOT proceed |

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

## Progress Reporting

```markdown
### Review Cycle Update (Round N)

| Metric | Count |
|--------|-------|
| Resolved this round | X |
| Remaining | Y |
| Current agent | name |
| Build status | passing/failing |

Status: Processing...
```

---

## FORBIDDEN

```
X pr_merge - merging requires human approval
X Ignoring pause-ai-review label
X Marking ANY comment resolved without fixing
X Skipping comments (regardless of severity)
X "Complex, will defer later"
X "Trivial, can skip"
X "Out of scope" without tech debt entry
X Exiting with unresolved comments
X Exiting with broken build
X Force-push or destructive git ops
```

---

## Quick Start

```
Review PR owner/repo#123
Review PR owner/repo#42 with round-robin using coderabbit and sourcery
```
