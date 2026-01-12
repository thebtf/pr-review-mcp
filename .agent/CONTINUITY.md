# Continuity — PR Review MCP Server

## Current State (2026-01-10)

### Branch: `main` (PR #3 merged)

### What's Done

1. **Core MCP Server** — 9 tools working:
   - `pr_summary` — statistics with multi-source support + nitpicks block
   - `pr_list` — filtering by resolved/file/source
   - `pr_get` — full comment details + AI prompt
   - `pr_resolve` — mark threads resolved (supports synthetic IDs)
   - `pr_changes` — cursor pagination
   - `pr_invoke` — invoke agents (CodeRabbit, Sourcery, Qodo)
   - `pr_claim_work` — claim file partition for parallel processing
   - `pr_report_progress` — report partition completion status
   - `pr_get_work_status` — get coordination run status

2. **Multi-Source Detection** — 6 agents:
   - CodeRabbit, Gemini, Copilot, Sourcery, Codex → inline review threads
   - Qodo → persistent issue comment (adapter created)

3. **Coordination System** — Parallel PR review:
   - `src/coordination/types.ts` — TypeScript interfaces + Zod schemas
   - `src/coordination/state.ts` — In-memory state manager (singleton)
   - `src/tools/coordination.ts` — 3 MCP tools implementation
   - File-based partitioning with severity ordering (CRIT → MAJOR → MINOR)
   - Atomic claim operations with ownership verification
   - Stale agent cleanup (5min timeout)

4. **Hybrid Nitpicks Tracking** — NEW:
   - In-memory Map + file persistence (`nitpicks-{owner}-{repo}-{pr}.json`)
   - Synthetic ID handling: `coderabbit-nitpick-*`
   - Atomic file writes via temp-file + rename
   - Lazy load on first PR access
   - Filter resolved nitpicks from pr_list output
   - Nitpicks block in pr_summary response

5. **Confidence Layer** — NEW in pr-review-worker:
   - ALWAYS/CONDITIONAL/NEVER keyword classification
   - Full investigation for security/auth/injection keywords
   - Light investigation for type/interface/performance
   - Skip investigation for formatting/style/naming
   - Tech debt recording to `.agent/status/TECHNICAL_DEBT.md`

6. **Skills** — `claude/skills/`:
   - `pr-review-orchestrator/SKILL.md` — Spawns workers, monitors progress, manages labels
   - `pr-review-worker/SKILL.md` — Claims partitions, fixes comments, reports progress
   - Both use proper frontmatter: `context: fork`, `agent: background`, `model: sonnet`
   - Worker forbidden from: labels, merge, invoke (orchestrator only)

7. **Qodo Adapter** — `src/adapters/qodo.ts`:
   - Fetches Qodo's persistent issue comment
   - Parses security concerns → CRIT severity
   - Parses focus areas → MAJOR severity

8. **Test Client** — `scripts/mcp-test-client.mjs`:
   - Interactive and quick-call modes
   - Correct MCP protocol (newline-delimited JSON)

### Tested Successfully

- PR #3: 28/28 comments resolved, 30/30 nitpicks resolved
- 4 parallel workers completed 5/5 partitions in ~3.5 min
- Hybrid nitpicks tracking working with file persistence
- Label coordination: only orchestrator manages `ai-review:*` labels

---

## Now

Adding Qodo Focus tracking (similar to CodeRabbit nitpicks) for synthetic IDs `qodo-focus-*`.

## Next

- Test round-robin review with CodeRabbit, Codex, Copilot
- Implement Qodo Focus body extraction (currently empty)

---

## Key Architecture

```
┌──────────────┐
│ ORCHESTRATOR │ ◄── pr-review-orchestrator skill
└──────┬───────┘
       │ 1. pr_summary → create partitions
       │ 2. spawn workers (Task tool, model=sonnet)
       │ 3. poll pr_get_work_status
       │ 4. aggregate results
       ▼
┌──────────────────────────────────────┐
│      MCP COORDINATION STATE          │
│  ┌────────┐ ┌────────┐ ┌────────┐   │
│  │ FileA  │ │ FileB  │ │ FileC  │   │
│  │pending │ │claimed │ │ done   │   │
│  └────────┘ └────────┘ └────────┘   │
└──────────────────────────────────────┘
       ▲           ▲           ▲
┌──────┴───┐ ┌─────┴────┐ ┌────┴─────┐
│ WORKER 1 │ │ WORKER 2 │ │ WORKER 3 │
│claim→fix │ │claim→fix │ │claim→fix │
│ →report  │ │ →report  │ │ →report  │
└──────────┘ └──────────┘ └──────────┘
```

---

## Synthetic ID Tracking

| Prefix | Source | Tracking |
|--------|--------|----------|
| `coderabbit-nitpick-*` | CodeRabbit inline nitpicks | Hybrid (memory + file) |
| `qodo-focus-*` | Qodo Focus areas | Hybrid (memory + file) |
| `qodo-security-*` | Qodo Security concerns | Hybrid (memory + file) |

---

## Test Client Usage

```bash
# Interactive mode
node scripts/mcp-test-client.mjs

# Quick calls
node scripts/mcp-test-client.mjs pr_summary 3
node scripts/mcp-test-client.mjs pr_claim_work agent1 null '{"owner":"thebtf","repo":"pr-review-mcp","pr":3}'
node scripts/mcp-test-client.mjs pr_get_work_status
node scripts/mcp-test-client.mjs pr_report_progress agent1 src/file.ts done
```

---

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| File-based partitioning | Eliminates merge conflicts between workers |
| 3-5 workers optimal | For ~50 comments, avoids coordination overhead |
| Claim-based coordination | No complex locks, atomic operations |
| Worker uses sonnet | Avoid opus token waste on background tasks |
| Labels via orchestrator only | Prevent conflicting label states |
| In-memory state | Simple, no persistence needed for single run |
| Stale timeout 5min | Balance between reliability and stuck claims |
| Hybrid nitpicks tracking | In-memory + file for persistence across sessions |
