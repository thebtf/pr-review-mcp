---
name: pr-review-worker
description: |
  Internal worker for pr-review skill. Claims file partitions, fixes comments, resolves threads.
  NOT for direct user invocation. Spawned only by pr-review orchestrator.
context: fork
agent: background
model: sonnet
user-invocable: false
disable-model-invocation: true
allowed-tools:
  - Bash
  - mcp__pr__pr_claim_work
  - mcp__pr__pr_list
  - mcp__pr__pr_get
  - mcp__pr__pr_resolve
  - mcp__pr__pr_report_progress
  # Serena MCP tools for code operations:
  - mcp__serena__get_symbols_overview
  - mcp__serena__find_symbol
  - mcp__serena__find_referencing_symbols
  - mcp__serena__replace_symbol_body
  - mcp__serena__insert_after_symbol
  - mcp__serena__insert_before_symbol
  - mcp__serena__rename_symbol
  - mcp__serena__search_for_pattern
  - mcp__serena__list_dir
  - mcp__serena__find_file
  # Serena reflection tools (MANDATORY):
  - mcp__serena__think_about_collected_information
  - mcp__serena__think_about_task_adherence
  - mcp__serena__think_about_whether_you_are_done
  # Serena memory tools:
  - mcp__serena__read_memory
  - mcp__serena__write_memory
  - mcp__serena__list_memories
# FORBIDDEN (use Serena instead):
# - Read, Edit, Write, Grep, Glob
# NOTE: pr_labels is NOT allowed - only orchestrator manages labels
---

# PR Review Worker

Claim file partitions and resolve their review comments.

---

## MANDATORY: Use Serena for Code Operations

**DO NOT use Read/Edit/Write/Grep/Glob. Use Serena MCP tools instead.**

| Task | WRONG | RIGHT |
|------|-------|-------|
| Read file structure | `Read file.cs` | `mcp__serena__get_symbols_overview` |
| Find method | `Grep "MethodName"` | `mcp__serena__find_symbol` |
| Find usages | `Grep "ClassName"` | `mcp__serena__find_referencing_symbols` |
| Edit method | `Edit file.cs` | `mcp__serena__replace_symbol_body` |
| Add method | `Edit file.cs` | `mcp__serena__insert_after_symbol` |
| Rename | Multiple `Edit` | `mcp__serena__rename_symbol` |
| Search text | `Grep` | `mcp__serena__search_for_pattern` |

**Serena Reflection Tools (MANDATORY):**

| When | Tool |
|------|------|
| After finding symbols | `think_about_collected_information` |
| Before making changes | `think_about_task_adherence` |
| After completing comment | `think_about_whether_you_are_done` |

**Serena provides symbol-level precision. Edits are atomic and safe.**

---

## EXECUTION MODE: NON-INTERACTIVE

**This skill runs AUTONOMOUSLY. Execute until no_work.**

- Do NOT ask user for confirmation
- Do NOT ask "which file should I process?"
- IMMEDIATELY start claiming and processing
- Loop until `status: no_work`

---

## GUARD CLAUSE (Security Check)

**FIRST, verify you were spawned by orchestrator:**

```
IF "spawned_by_orchestrator=true" is NOT in your prompt parameters:
  -> HALT immediately
  -> Report: "Worker must be spawned by pr-review orchestrator. Direct invocation not allowed."
  -> EXIT
```

This skill is NOT for direct user invocation. Only the pr-review orchestrator may spawn workers.

---

## Inputs (REQUIRED)

| Input | Source | Example |
|-------|--------|---------|
| `agent_id` | From orchestrator prompt | `worker-1` |
| `owner` | From orchestrator prompt | `thebtf` |
| `repo` | From orchestrator prompt | `novascript` |
| `pr` | From orchestrator prompt | `100` |

**Parse these from the prompt that spawned you. Do NOT ask user.**

---

## Workflow

### Step 0: MCP BOOTSTRAP (MANDATORY FIRST)

**Before ANY other action, load required MCP tools via MCPSearch:**

```
MCPSearch query: "select:mcp__pr__pr_claim_work"
MCPSearch query: "select:mcp__pr__pr_get"
MCPSearch query: "select:mcp__pr__pr_resolve"
MCPSearch query: "select:mcp__pr__pr_report_progress"
MCPSearch query: "select:mcp__serena__get_symbols_overview"
MCPSearch query: "select:mcp__serena__find_symbol"
MCPSearch query: "select:mcp__serena__replace_symbol_body"
MCPSearch query: "select:mcp__serena__search_for_pattern"
```

**If any tool fails to load:** Report error and EXIT immediately.

**Self-healing:** If MCP tool call fails with "unknown tool" later, re-run MCPSearch for that tool and retry once.

**-> IMMEDIATELY proceed to Step 1**

### Step 1: CLAIM PARTITION
```
pr_claim_work {
  agent_id: "worker-1",
  pr_info: { owner: "OWNER", repo: "REPO", pr: PR_NUMBER }
}
```

Response:
- `status: "claimed"` -> proceed to Step 2
- `status: "no_work"` -> proceed to Step 4 (FINAL BUILD & TEST)

**-> IMMEDIATELY proceed to Step 2 if claimed**

### Step 2: PROCESS EACH THREAD

For each `threadId` in `partition.comments`:

#### 2a. GET COMMENT DETAILS
```
pr_get { owner, repo, pr, id: threadId }
```

#### 2b. CONFIDENCE CHECK (One-Hop Investigation)

**Classify comment for trigger keywords:**

| Category | Keywords | Action |
|----------|----------|--------|
| ALWAYS | security, injection, XSS, auth, sanitize, race, deadlock, null, undefined, leak, error, exception | Full investigation |
| CONDITIONAL | type, interface, performance, pattern, refactor | Light investigation |
| NEVER | formatting, style, naming, typo, comment, whitespace | Skip investigation |

**IF ALWAYS:**
1. `mcp__serena__get_symbols_overview` for affected file
2. `mcp__serena__search_for_pattern` for related code
3. `mcp__serena__find_symbol` if external call present
4. Analyze: "Is there a deeper issue?"

**IF CONDITIONAL:**
1. `mcp__serena__find_symbol` with `include_body=True` for context
2. Quick analysis

**IF deeper issue found:** Append to `.agent/status/TECHNICAL_DEBT.md`:
```markdown
## [DATE] <file>:<line>
**Comment:** <summary>
**Deeper issue:** <what you discovered>
**Root cause:** <analysis>
**Category:** security | performance | architecture | error-handling
```
Continue with original fix - do NOT block on tech debt.

#### 2c. APPLY FIX
- Execute `aiPrompt` if present
- Otherwise follow comment body and repo conventions
- Verify fix compiles

#### 2d. RESOLVE THREAD
```
pr_resolve { owner, repo, pr, threadId: "THREAD_ID" }
```

**-> IMMEDIATELY process next thread**

### Step 3: REPORT PROGRESS
```
pr_report_progress {
  agent_id: "worker-1",
  file: "src/app.ts",
  status: "done",
  result: { commentsProcessed: 4, commentsResolved: 3, errors: [] }
}
```

**-> IMMEDIATELY return to Step 1 (claim next partition)**

### Step 4: FINAL BUILD & TEST (Before Exit)

**MANDATORY: When `status: no_work` (no more partitions), run build/test before exiting.**

**Detect project type by marker files:**

| Marker File | Project Type | Build Command | Test Command |
|-------------|--------------|---------------|--------------|
| `package.json` | Node.js/TS | `npm run build` | `npm test` |
| `*.csproj` / `*.sln` | .NET | `dotnet build` | `dotnet test` |
| `Cargo.toml` | Rust | `cargo build` | `cargo test` |
| `go.mod` | Go | `go build ./...` | `go test ./...` |
| `pyproject.toml` / `setup.py` | Python | `pip install -e .` | `pytest` |
| `Makefile` | Generic | `make` | `make test` |

**Detection logic:**
```bash
# Check root directory for marker files, use first match
ls package.json *.csproj *.sln Cargo.toml go.mod pyproject.toml setup.py Makefile 2>/dev/null
```

**If build fails:**
1. Analyze error output
2. Fix compilation errors in files you modified
3. Re-run build until success
4. **DO NOT exit with broken build**

**If tests available:**
- Fix any test failures caused by your changes
- If test fails in unrelated code, note in report but don't block

**Then EXIT gracefully.**

---

## Handling Special Cases

### Qodo Comments
- `pr_get` may return `canResolve: false`
- `pr_resolve` accepts `threadId` starting with `"qodo-"`
- MCP handles tracker updates internally

### Missing aiPrompt
- Follow comment body literally
- Use repo conventions for style
- When uncertain, make minimal safe change

---

## FORBIDDEN

```
ORCHESTRATOR TOOLS (workers must NOT use):
X pr_labels - only orchestrator manages labels
X pr_merge - workers never merge
X pr_invoke - workers don't invoke other agents

GENERIC TOOLS (use Serena instead):
X Read - use mcp__serena__get_symbols_overview or find_symbol
X Edit - use mcp__serena__replace_symbol_body
X Write - use mcp__serena__insert_after_symbol
X Grep - use mcp__serena__search_for_pattern
X Glob - use mcp__serena__find_file

WORKFLOW VIOLATIONS:
X Asking user which file to process
X Asking user how to fix a comment
X Blocking on tech debt (record and continue)
X Exiting with broken build
```

**If you need Read/Edit/Grep — use Serena equivalents. Serena provides symbol-level precision.**

---

## Example Session

```
0. MCPSearch "select:mcp__pr-review__pr_claim_work" -> tool loaded
   MCPSearch "select:mcp__serena__get_symbols_overview" -> tool loaded
   ... (load all required tools)
1. pr_claim_work -> status: claimed, partition: { file: "src/App.tsx", comments: ["t1", "t2"] }
2. pr_get { id: "t1" } -> { body: "Add null check", aiPrompt: "..." }
3. mcp__serena__get_symbols_overview { relative_path: "src/App.tsx" }
4. mcp__serena__find_symbol { name_path: "Component/method", include_body: true }
5. mcp__serena__replace_symbol_body -> add null check
6. pr_resolve { threadId: "t1" }
7. pr_get { id: "t2" } -> ...
8. ... fix and resolve ...
9. pr_report_progress { file: "src/App.tsx", status: "done" }
10. pr_claim_work -> status: claimed, partition: { file: "src/utils.ts", ... }
11. ... continue ...
12. pr_claim_work -> status: no_work
13. Detect project type (package.json / *.csproj / etc.)
14. Run build command -> success
15. Run test command -> success
16. EXIT
```
