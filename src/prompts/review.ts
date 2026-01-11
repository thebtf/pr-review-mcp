/**
 * PR Review Orchestrator Prompt
 *
 * Generates dynamic prompt with pre-fetched data for autonomous PR review processing.
 * Supports single PR or batch processing of all open PRs.
 * 
 * Usage:
 * - /pr:review                    → All PRs in current repo (infer from git)
 * - /pr:review 4                  → PR #4 in current repo
 * - /pr:review https://...        → PR from URL
 * - /pr:review owner/repo#123     → PR from short format
 */

import { GitHubClient } from '../github/client.js';
import { prSummary } from '../tools/summary.js';
import { prListPRs } from '../tools/list-prs.js';
import { prGetWorkStatus } from '../tools/coordination.js';
import { getEnvConfig, type InvokableAgentId, type ReviewMode } from '../agents/registry.js';

// ============================================================================
// Types
// ============================================================================

export interface ReviewPromptArgs {
  /** Repository owner */
  owner?: string;
  /** Repository name */
  repo?: string;
  /** PR number, GitHub URL, or short format (owner/repo#123) */
  pr?: string;
  /** Number of workers */
  workers?: string;
}

// ============================================================================
// URL Parsing
// ============================================================================

interface ParsedPRUrl {
  owner: string;
  repo: string;
  pr: number;
}

/**
 * Parse GitHub PR URL or short format
 * Supports:
 * - https://github.com/owner/repo/pull/123
 * - owner/repo#123
 */
function parseGitHubPRUrl(input: string): ParsedPRUrl | null {
  // Full URL pattern
  const urlPattern = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i;
  const urlMatch = input.match(urlPattern);
  if (urlMatch) {
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      pr: parseInt(urlMatch[3], 10)
    };
  }

  // Short format: owner/repo#123
  const shortPattern = /^([^/]+)\/([^#]+)#(\d+)$/;
  const shortMatch = input.match(shortPattern);
  if (shortMatch) {
    return {
      owner: shortMatch[1],
      repo: shortMatch[2],
      pr: parseInt(shortMatch[3], 10)
    };
  }

  return null;
}

/**
 * Check if input is just a PR number
 */
function isPRNumber(input: string): boolean {
  return /^\d+$/.test(input.trim());
}

interface PRTarget {
  owner: string;
  repo: string;
  pr: number;
  title?: string;
  unresolved?: number;
}

interface PromptContext {
  targets: PRTarget[];
  currentSummary?: {
    total: number;
    resolved: number;
    unresolved: number;
    bySeverity: Record<string, number>;
  };
  workStatus?: {
    isActive: boolean;
    runAge?: number;
  };
  desiredWorkers: number;
  envConfig: {
    agents: InvokableAgentId[];
    mode: ReviewMode;
  };
  /** If true, need to infer owner/repo from git remote */
  inferRepo?: boolean;
  /** Requested PR number when only number provided */
  requestedPR?: number;
}

// ============================================================================
// Orchestrator Workflow Template
// ============================================================================

const ORCHESTRATOR_WORKFLOW = `
## EXECUTION MODE: AUTONOMOUS

**Execute ALL steps without stopping. Do NOT ask for confirmation.**

### ORCHESTRATOR ROLE

You are the ORCHESTRATOR. You spawn workers, monitor progress, ensure build passes.

| Orchestrator DOES | Orchestrator DOES NOT |
|-------------------|----------------------|
| Spawn workers via Task tool | Read/Edit code files |
| Monitor via pr_poll_updates | Call pr_list, pr_get |
| Set labels via pr_labels | Call pr_resolve |
| Track progress via pr_get_work_status | Process comments directly |

**If you use pr_list, pr_get, pr_resolve, Read, Edit — STOP. Spawn workers instead.**

---

## SAFETY RULES

| Rule | Enforcement |
|------|-------------|
| **NO AUTO-MERGE** | NEVER call pr_merge |
| **ESCAPE HATCH** | Stop if \`pause-ai-review\` label present |
| **FIX ALL** | Process ALL comments. No skipping. |
| **BUILD MUST PASS** | Never finish with broken build. |

---

## State Machine

\`\`\`
ESCAPE_CHECK -> INVOKE_AGENTS -> POLL_WAIT
                                     |
                    +----------------+----------------+
                    |                                 |
              allAgentsReady?                   pause label?
                    |                                 |
              +-----+-----+                      STOP (user)
              no          yes
              |            |
           (wait)    unresolved > 0?
                          |
                    +-----+-----+
                    yes         no
                    |            |
             SPAWN_WORKERS    BUILD_TEST -> COMPLETE
                    |
                    v
                MONITOR -> BUILD_TEST -> POLL_WAIT (re-review)
\`\`\`

---

## Workflow Steps

### Step 1: ESCAPE CHECK
\`\`\`
pr_labels { owner, repo, pr, action: "get" }
\`\`\`
- \`pause-ai-review\` present → **STOP**
- PR closed/merged → **STOP**

### Step 2: PREFLIGHT
\`\`\`
pr_get_work_status {}
\`\`\`
- \`isActive && runAge < 300000\` → **ABORT** (another orchestrator)
- \`isActive && runAge >= 300000\` → Stale, proceed

### Step 3: LABEL
\`\`\`
pr_labels { owner, repo, pr, action: "set", labels: ["ai-review:active"] }
\`\`\`

### Step 4: INVOKE AGENTS
\`\`\`
pr_invoke { owner, repo, pr, agent: "all" }
\`\`\`

### Step 5: POLL & WAIT
\`\`\`
pr_poll_updates { owner, repo, pr, include: ["comments", "agents"] }
\`\`\`
- \`allAgentsReady: false\` → wait 30s, poll again
- \`allAgentsReady: true, unresolved > 0\` → Step 6
- \`allAgentsReady: true, unresolved === 0\` → Step 8

### Step 6: SPAWN WORKERS (PARALLEL)

**CRITICAL: Send ALL Task calls in ONE message for parallelism.**

\`\`\`typescript
// SINGLE message with MULTIPLE Task calls:
Task({ subagent_type: "general-purpose", run_in_background: true, model: "sonnet", prompt: "...worker-1..." })
Task({ subagent_type: "general-purpose", run_in_background: true, model: "sonnet", prompt: "...worker-2..." })
Task({ subagent_type: "general-purpose", run_in_background: true, model: "sonnet", prompt: "...worker-3..." })
\`\`\`

**Worker prompt template:**
\`\`\`
Execute skill pr-review-worker.

Parameters:
- agent_id: worker-{N}
- owner: {OWNER}
- repo: {REPO}
- pr: {PR_NUMBER}
- spawned_by_orchestrator: true

CRITICAL FIRST STEP (MCP tool bootstrap):
1) Call MCPSearch to load MCP tools:
   - MCPSearch query: "select:mcp__pr__pr_claim_work"
   - MCPSearch query: "select:mcp__pr__pr_get"
   - MCPSearch query: "select:mcp__pr__pr_resolve"
   - MCPSearch query: "select:mcp__pr__pr_report_progress"
   - MCPSearch query: "select:mcp__serena__find_symbol"
   - MCPSearch query: "select:mcp__serena__replace_symbol_body"

Then claim partitions, fix comments, resolve threads.
Work autonomously until no_work.
\`\`\`

### Step 7: MONITOR
\`\`\`
pr_get_work_status {}
\`\`\`
Poll every 30s until all partitions complete.

### Step 8: BUILD & TEST

| Marker | Build | Test |
|--------|-------|------|
| package.json | npm run build | npm test |
| *.csproj | dotnet build | dotnet test |
| Cargo.toml | cargo build | cargo test |
| go.mod | go build ./... | go test ./... |

**If build fails → spawn repair worker → retry.**

### Step 9: COMPLETION
\`\`\`
pr_labels { owner, repo, pr, action: "set", labels: ["ai-review:passed"] }
\`\`\`

Report: "PR Review Complete. Ready for human review."

---

## FORBIDDEN

\`\`\`
X pr_merge (requires human)
X pr_list, pr_get, pr_resolve (workers only)
X Read, Edit, Write (workers only)
X Processing comments yourself
X Spawning workers ONE BY ONE
X Asking "should I start?"
\`\`\`
`;

// ============================================================================
// Prompt Generator
// ============================================================================

/**
 * Generate the review prompt with pre-fetched context
 */
export async function generateReviewPrompt(
  args: ReviewPromptArgs,
  client: GitHubClient
): Promise<string> {
  const context = await buildContext(args, client);

  // Need to infer repo from git
  if (context.inferRepo) {
    return generateInferRepoPrompt(context);
  }

  if (context.targets.length === 0) {
    return generateNoTargetsPrompt(args);
  }

  if (context.targets.length === 1) {
    return generateSinglePRPrompt(context);
  }

  return generateBatchPrompt(context);
}

/**
 * Normalize arguments - parse URL or short format if provided
 */
function normalizeArgs(args: ReviewPromptArgs): { owner?: string; repo?: string; pr?: number; prNumberOnly?: boolean } {
  // Check if 'pr' arg is a URL or short format
  if (args.pr) {
    const parsed = parseGitHubPRUrl(args.pr);
    if (parsed) {
      return {
        owner: parsed.owner,
        repo: parsed.repo,
        pr: parsed.pr
      };
    }

    // Check if it's just a number
    if (isPRNumber(args.pr)) {
      return {
        owner: args.owner,
        repo: args.repo,
        pr: parseInt(args.pr, 10),
        prNumberOnly: !args.owner || !args.repo
      };
    }
  }

  return {
    owner: args.owner,
    repo: args.repo,
    pr: args.pr ? parseInt(args.pr, 10) : undefined
  };
}

/**
 * Build context with pre-fetched data
 */
async function buildContext(
  args: ReviewPromptArgs,
  client: GitHubClient
): Promise<PromptContext> {
  const desiredWorkers = parseInt(args.workers || '3', 10);
  const envConfig = getEnvConfig();

  // Normalize args (parse URL if provided)
  const normalized = normalizeArgs(args);

  // If we need to infer owner/repo (no args or just PR number)
  if (!normalized.owner || !normalized.repo) {
    return {
      targets: [],
      desiredWorkers,
      envConfig,
      inferRepo: true,
      requestedPR: normalized.pr
    };
  }

  // If specific PR provided (either directly or via URL)
  if (normalized.pr) {
    try {
      // Pre-fetch summary and work status in parallel
      const [summary, workStatus] = await Promise.all([
        prSummary({ owner: normalized.owner, repo: normalized.repo, pr: normalized.pr }, client),
        prGetWorkStatus({})
      ]);

      return {
        targets: [{
          owner: normalized.owner,
          repo: normalized.repo,
          pr: normalized.pr,
          unresolved: summary.unresolved
        }],
        currentSummary: {
          total: summary.total,
          resolved: summary.resolved,
          unresolved: summary.unresolved,
          bySeverity: summary.bySeverity
        },
        workStatus: {
          isActive: workStatus.isActive,
          runAge: workStatus.runAge ?? undefined
        },
        desiredWorkers,
        envConfig
      };
    } catch {
      // If pre-fetch fails, return minimal context
      return {
        targets: [{ owner: normalized.owner, repo: normalized.repo, pr: normalized.pr }],
        desiredWorkers,
        envConfig
      };
    }
  }

  // If only owner/repo - get all open PRs
  try {
    const prs = await prListPRs(
      { owner: normalized.owner, repo: normalized.repo, state: 'OPEN', limit: 20 },
      client
    );

    const targets: PRTarget[] = prs.pullRequests.map(p => ({
      owner: normalized.owner!,
      repo: normalized.repo!,
      pr: p.number,
      title: p.title,
      unresolved: p.stats.reviewThreads
    }));

    // Filter to PRs with unresolved comments
    const withComments = targets.filter(t => (t.unresolved ?? 0) > 0);

    return {
      targets: withComments.length > 0 ? withComments : targets.slice(0, 5),
      desiredWorkers,
      envConfig
    };
  } catch {
    return { targets: [], desiredWorkers, envConfig };
  }
}

/**
 * Generate prompt when repo needs to be inferred from git
 */
function generateInferRepoPrompt(context: PromptContext): string {
  const { desiredWorkers, envConfig, requestedPR } = context;

  const prInstruction = requestedPR
    ? `Process PR **#${requestedPR}** in the current repository.`
    : `Process **all open PRs** with unresolved comments in the current repository.`;

  return `# PR Review

## Step 0: RESOLVE REPOSITORY

**First, determine the repository from git remote:**

\`\`\`bash
git remote get-url origin
\`\`\`

Parse the output to extract \`owner\` and \`repo\`:
- \`https://github.com/OWNER/REPO.git\` → owner=OWNER, repo=REPO
- \`git@github.com:OWNER/REPO.git\` → owner=OWNER, repo=REPO

${prInstruction}

## Configuration
- **Agents to invoke**: ${envConfig.agents.join(', ')}
- **Review mode**: ${envConfig.mode}
- **Workers**: ${desiredWorkers}
${requestedPR ? `- **Target PR**: #${requestedPR}` : '- **Target**: All open PRs with comments'}

---

**After resolving owner/repo, proceed with the workflow:**

${ORCHESTRATOR_WORKFLOW}

---

**START NOW. Execute Step 0 to get repository info.**`;
}

/**
 * Generate prompt when no targets found
 */
function generateNoTargetsPrompt(args: ReviewPromptArgs): string {
  if (!args.owner || !args.repo) {
    return `# PR Review

No repository specified and could not be inferred.

**Usage:**
- \`/pr:review\` — All PRs in current repo (requires git remote)
- \`/pr:review 4\` — PR #4 in current repo
- \`/pr:review https://github.com/owner/repo/pull/123\` — Specific PR
- \`/pr:review owner/repo#123\` — Short format

Alternatively, run from a git repository directory.`;
  }

  return `# PR Review: ${args.owner}/${args.repo}

No open PRs found with review comments to process.

To review a specific PR, provide the PR number: \`/pr:review 4\``;
}

/**
 * Generate prompt for single PR
 */
function generateSinglePRPrompt(context: PromptContext): string {
  const target = context.targets[0];
  const { currentSummary, workStatus, desiredWorkers, envConfig } = context;

  let header = `# PR Review: ${target.owner}/${target.repo}#${target.pr}

## Pre-fetched Context
`;

  if (currentSummary) {
    header += `
### Review Status
| Metric | Count |
|--------|-------|
| Total comments | ${currentSummary.total} |
| Resolved | ${currentSummary.resolved} |
| **Unresolved** | **${currentSummary.unresolved}** |

### By Severity
${Object.entries(currentSummary.bySeverity)
  .map(([sev, count]) => `- ${sev}: ${count}`)
  .join('\n')}
`;
  }

  if (workStatus) {
    header += `
### Coordination Status
- Active run: ${workStatus.isActive ? 'Yes' : 'No'}
${workStatus.isActive ? `- Run age: ${Math.round((workStatus.runAge || 0) / 1000)}s` : ''}
`;
  }

  header += `
### Configuration
- **Agents to invoke**: ${envConfig.agents.join(', ')}
- **Review mode**: ${envConfig.mode}
- Desired workers: ${desiredWorkers}
- Target: ${target.owner}/${target.repo}#${target.pr}

---

## Workflow

${ORCHESTRATOR_WORKFLOW}

---

**START NOW. Execute Step 1 immediately.**`;

  return header;
}

/**
 * Generate prompt for batch processing
 */
function generateBatchPrompt(context: PromptContext): string {
  const { targets, desiredWorkers, envConfig } = context;

  const prList = targets
    .map(t => `| #${t.pr} | ${t.title || '-'} | ${t.unresolved ?? '?'} |`)
    .join('\n');

  return `# PR Review: Batch Processing

## PRs to Process

| PR | Title | Unresolved |
|----|-------|------------|
${prList}

## Configuration
- **Agents to invoke**: ${envConfig.agents.join(', ')}
- **Review mode**: ${envConfig.mode}
- Total PRs: ${targets.length}
- Workers per PR: ${desiredWorkers}

## Execution Plan

Process PRs **${envConfig.mode === 'parallel' ? 'in parallel' : 'sequentially'}**:

\`\`\`
for each PR in [${targets.map(t => `#${t.pr}`).join(', ')}]:
  1. Run full orchestrator workflow
  2. Wait for completion
  3. Move to next PR
\`\`\`

${ORCHESTRATOR_WORKFLOW}

---

**START NOW with PR #${targets[0].pr}.**`;
}

// ============================================================================
// Prompt Definition for MCP
// ============================================================================

export const REVIEW_PROMPT_DEFINITION = {
  name: 'review',
  title: 'PR Review Orchestrator',
  description: 'Autonomous multi-agent PR review. Process all comments until ready for merge.',
  arguments: [
    {
      name: 'pr',
      description: 'PR number, GitHub URL (https://github.com/owner/repo/pull/123), or short format (owner/repo#123). Omit to process all open PRs.',
      required: false
    },
    {
      name: 'workers',
      description: 'Number of parallel workers (default: 3)',
      required: false
    }
  ]
};
