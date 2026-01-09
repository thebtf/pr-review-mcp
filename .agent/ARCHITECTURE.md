# Architecture — PR Review MCP Server

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         MCP CLIENT                              │
│                   (Claude Desktop, etc.)                        │
└─────────────────────────────┬───────────────────────────────────┘
                              │ JSON-RPC over stdio
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      server.ts                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ Tools       │  │ Prompts     │  │ Error Handling          │  │
│  │ Handler     │  │ Handler     │  │ (StructuredError)       │  │
│  └──────┬──────┘  └─────────────┘  └─────────────────────────┘  │
└─────────┼───────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│                         TOOLS LAYER                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │ summary  │ │  list    │ │   get    │ │ resolve  │            │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘            │
│  ┌────┴─────┐ ┌────┴─────┐                                      │
│  │ changes  │ │  invoke  │                                      │
│  └────┬─────┘ └────┬─────┘                                      │
└───────┼────────────┼────────────────────────────────────────────┘
        │            │
        ▼            ▼
┌───────────────┐  ┌───────────────┐
│ ADAPTERS      │  │ AGENTS        │
│ ┌───────────┐ │  │ ┌───────────┐ │
│ │ qodo.ts   │ │  │ │registry.ts│ │
│ │ (issue    │ │  │ │(configs)  │ │
│ │ comments) │ │  │ └───────────┘ │
│ └───────────┘ │  │ ┌───────────┐ │
└───────┬───────┘  │ │invoker.ts │ │
        │          │ │(posting)  │ │
        │          │ └───────────┘ │
        │          └───────┬───────┘
        │                  │
        ▼                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                      GITHUB LAYER                               │
│  ┌──────────────────┐  ┌──────────────────┐                     │
│  │ client.ts        │  │ queries.ts       │                     │
│  │ - graphql()      │  │ - listThreads    │                     │
│  │ - spawnSync(gh)  │  │ - resolveThread  │                     │
│  └────────┬─────────┘  └──────────────────┘                     │
│           │                                                     │
│  ┌────────┴─────────┐                                           │
│  │ EXTRACTORS       │                                           │
│  │ ├─ severity.ts   │  (CRIT/MAJOR/MINOR/NITPICK)              │
│  │ └─ prompt.ts     │  (AI prompt extraction)                   │
│  └──────────────────┘                                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │   GitHub API    │
                    │   (via gh CLI)  │
                    └─────────────────┘
```

---

## Data Flow

### 1. Review Thread Flow (CodeRabbit, Gemini, Copilot, Sourcery, Codex)

```
GitHub GraphQL API
        │
        ▼ reviewThreads query
┌───────────────────┐
│ Raw ReviewThread  │
│ {                 │
│   id, path, line, │
│   isResolved,     │
│   comments[]      │
│ }                 │
└─────────┬─────────┘
          │
          ▼ processThread()
┌───────────────────┐
│ ProcessedComment  │
│ {                 │
│   id, file, line, │
│   severity,       │  ← extractSeverity()
│   source,         │  ← detectSource()
│   aiPrompt,       │  ← extractPrompt()
│   ...             │
│ }                 │
└───────────────────┘
```

### 2. Qodo Flow (Issue Comment)

```
GitHub REST API
        │
        ▼ issues/{pr}/comments
┌───────────────────┐
│ Issue Comment     │
│ {                 │
│   body: "## PR    │
│   Reviewer Guide" │
│ }                 │
└─────────┬─────────┘
          │
          ▼ parseQodoComment()
┌───────────────────┐
│ QodoReview        │
│ {                 │
│   securityConcerns│  ← CRIT
│   focusAreas[]    │  ← MAJOR
│ }                 │
└─────────┬─────────┘
          │
          ▼ qodoToNormalizedComments()
┌───────────────────┐
│ QodoComment[]     │
│ (same interface)  │
└───────────────────┘
```

---

## File Responsibilities

### `/src/server.ts`
**MCP Server Entry Point**
- Registers tools and prompts
- Routes tool calls to handlers
- Error handling and logging

```typescript
// Key methods
setupToolHandlers()   // Register 6 tools
setupPromptHandlers() // Register pr-review prompt
setupErrorHandling()  // SIGINT, error logging
run()                 // Start stdio transport
```

### `/src/github/client.ts`
**GitHub CLI Wrapper**
- Executes `gh` commands via `spawnSync`
- GraphQL query execution
- Authentication check
- Circuit breaker pattern

```typescript
class GitHubClient {
  graphql<T>(query, variables)  // Execute GraphQL
  checkPrerequisites()          // Verify gh auth
}

class StructuredError {
  kind: 'auth' | 'rate_limit' | 'not_found' | 'network' | 'unknown'
  userAction?: string  // "Run: gh auth login"
}
```

### `/src/github/queries.ts`
**GraphQL Queries**
```typescript
QUERIES = {
  listThreads,    // Fetch review threads with pagination
  resolveThread,  // Mutation: resolve thread
  unresolveThread // Mutation: unresolve thread
}
```

### `/src/github/types.ts`
**TypeScript Interfaces**
- `CommentSource` — union type for all agents
- `ProcessedComment` — normalized comment structure
- Tool input/output types (SummaryInput, ListOutput, etc.)

---

## Tool Implementations

### `pr_summary` (summary.ts)
```typescript
Input:  { owner, repo, pr }
Output: { total, resolved, unresolved, bySeverity, byFile }

Flow:
1. fetchAllThreads() + fetchQodoReview() in parallel
2. Count resolved/unresolved
3. Aggregate by severity and file
```

### `pr_list` (list.ts)
```typescript
Input:  { owner, repo, pr, filter?, max? }
Output: { comments[], total, hasMore }

Flow:
1. fetchAllThreads() with filter
2. fetchQodoReview()
3. Apply filters to Qodo comments
4. Merge and return
```

### `pr_get` (get.ts)
```typescript
Input:  { owner, repo, pr, id }
Output: { id, file, line, severity, body, aiPrompt, replies }

Flow:
1. fetchAllThreads() (TODO: optimize to fetch single)
2. Find by id or threadId
3. Return full details
```

### `pr_resolve` (resolve.ts)
```typescript
Input:  { owner, repo, pr, threadId }
Output: { success, threadId, file, title }

Flow:
1. Execute resolveThread mutation
2. Return confirmation with context
```

### `pr_changes` (changes.ts)
```typescript
Input:  { owner, repo, pr, cursor?, max? }
Output: { comments[], cursor, hasMore }

Flow:
1. fetchAllThreads() starting from cursor
2. Return page + next cursor
```

### `pr_invoke` (invoke.ts)
```typescript
Input:  { owner, repo, pr, agent, options? }
Output: { success, invoked[], failed[], message }

Flow:
1. Get agent config from registry
2. Build command with options
3. Post via `gh pr comment`
4. Return result
```

---

## Adapters

### Qodo Adapter (`/src/adapters/qodo.ts`)

**Purpose:** Parse Qodo's non-standard issue comment format

```typescript
interface QodoReview {
  commentId: number
  commitSha: string
  effort: number           // 1-5 review difficulty
  hasTests: boolean
  securityConcerns[]       // CRIT severity
  focusAreas[]             // MAJOR severity
}

interface QodoComment {
  id: string
  source: 'qodo'
  file: string             // URL (can't extract path from hash)
  line: number | null
  severity: 'CRIT' | 'MAJOR'
  title: string
  body: string
  resolved: false          // Always unresolved (can't mark via API)
}
```

**Parsing Strategy:**
1. Fetch issue comments from `qodo-code-review[bot]`
2. Find comment with marker `## PR Reviewer Guide`
3. Parse `<table>` for security concerns (🔒)
4. Parse `<details><summary>` for focus areas (⚡)
5. Extract line numbers from URL: `#diff-...R{start}-R{end}`

---

## Agents Module

### Registry (`/src/agents/registry.ts`)

```typescript
interface AgentConfig {
  name: string
  command: string           // "@coderabbitai review" or "/review"
  type: 'mention' | 'slash'
  supports: string[]        // ['focus', 'files', 'incremental']
  msysWorkaround?: boolean  // For Windows slash commands
  authorPattern: string     // For detection
}

INVOKABLE_AGENTS = {
  coderabbit: { command: '@coderabbitai review', ... },
  sourcery:   { command: '@sourcery-ai review', ... },
  qodo:       { command: '/review', msysWorkaround: true, ... }
}
```

### Invoker (`/src/agents/invoker.ts`)

```typescript
// Build command with options
buildCommand(config, options) → "@coderabbitai review focus:security"

// Post comment via gh CLI
postInvocationComment(owner, repo, pr, command, config)

// Handle MSYS path conversion on Windows
env = config.msysWorkaround && win32
  ? { MSYS_NO_PATHCONV: '1' }
  : process.env
```

---

## Extractors

### Severity (`/src/extractors/severity.ts`)

**Detection Priority:**
1. Explicit markers: `[CRITICAL]`, `🚨`, `severity: critical`
2. Keywords: "security vulnerability", "memory leak", "data loss"
3. Patterns: emojis, formatting

**Severity Levels:**
| Level | Meaning | Examples |
|-------|---------|----------|
| CRIT | Must fix | Security, crashes, data loss |
| MAJOR | Should fix | Bugs, type errors, perf issues |
| MINOR | Nice to have | Style, naming, minor refactor |
| NITPICK | Optional | Cosmetic, preferences |
| N/A | Informational | Questions, praise |

### Prompt (`/src/extractors/prompt.ts`)

**AI Prompt Extraction:**
Looks for actionable code suggestions in comments:
- Code blocks with file references
- "Replace X with Y" patterns
- Specific line change instructions

```typescript
extractPrompt(body) → { text: string, confidence: 'high' | 'low' } | null
```

---

## Shared Utilities (`/src/tools/shared.ts`)

```typescript
// Main data fetching function
fetchAllThreads(client, owner, repo, pr, options) → {
  comments: ProcessedComment[]
  totalCount: number
  cursor: string | null
  hasMore: boolean
}

// Process single thread into normalized format
processThread(thread) → ProcessedComment

// Detect comment source by author
detectSource(author) → CommentSource
```

---

## Configuration

### Repo Config (`.github/pr-review.json`)

```json
{
  "version": 1,
  "invoke": {
    "agents": ["coderabbit", "sourcery"],
    "defaults": {
      "focus": "security"
    }
  }
}
```

Used by `pr_invoke` when `agent: 'all'`.

---

## Error Handling

### StructuredError

```typescript
class StructuredError extends Error {
  kind: 'auth' | 'rate_limit' | 'not_found' | 'network' | 'unknown'
  retryable: boolean
  userAction?: string  // Human-readable fix
}

// Converted to McpError for MCP protocol
throw new McpError(ErrorCode.InvalidRequest, error.message)
```

### Common Errors

| Error | Cause | Resolution |
|-------|-------|------------|
| `auth` | gh not logged in | `gh auth login` |
| `rate_limit` | Too many requests | Wait and retry |
| `not_found` | PR doesn't exist | Check owner/repo/pr |
| `network` | Connection failed | Check internet |
