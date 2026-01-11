/**
 * PR Review Orchestrator Prompt
 *
 * Generates dynamic prompt with pre-fetched data for autonomous PR review processing.
 * Supports single PR or batch processing of all open PRs.
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
  owner?: string;
  repo?: string;
  pr?: string;
  workers?: string;
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
   - MCPSearch query: "select:mcp__pr-review__pr_claim_work"
   - MCPSearch query: "select:mcp__pr-review__pr_get"
   - MCPSearch query: "select:mcp__pr-review__pr_resolve"
   - MCPSearch query: "select:mcp__pr-review__pr_report_progress"
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

  if (context.targets.length === 0) {
    return generateNoTargetsPrompt(args);
  }

  if (context.targets.length === 1) {
    return generateSinglePRPrompt(context);
  }

  return generateBatchPrompt(context);
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

  // If specific PR provided
  if (args.owner && args.repo && args.pr) {
    const pr = parseInt(args.pr, 10);

    try {
      // Pre-fetch summary and work status in parallel
      const [summary, workStatus] = await Promise.all([
        prSummary({ owner: args.owner, repo: args.repo, pr }, client),
        prGetWorkStatus({})
      ]);

      return {
        targets: [{
          owner: args.owner,
          repo: args.repo,
          pr,
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
        targets: [{ owner: args.owner, repo: args.repo, pr }],
        desiredWorkers,
        envConfig
      };
    }
  }

  // If only owner/repo - get all open PRs
  if (args.owner && args.repo) {
    try {
      const prs = await prListPRs(
        { owner: args.owner, repo: args.repo, state: 'OPEN', limit: 20 },
        client
      );

      const targets: PRTarget[] = prs.pullRequests.map(p => ({
        owner: args.owner!,
        repo: args.repo!,
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

  return { targets: [], desiredWorkers, envConfig };
}

/**
 * Generate prompt when no targets found
 */
function generateNoTargetsPrompt(args: ReviewPromptArgs): string {
  if (!args.owner || !args.repo) {
    return `# PR Review

No repository specified. Please provide:
- \`owner\`: Repository owner (username or organization)
- \`repo\`: Repository name
- \`pr\` (optional): Pull request number, or omit for all open PRs

Example: \`/pr-review:review owner=myorg repo=myproject pr=100\``;
  }

  return `# PR Review: ${args.owner}/${args.repo}

No open PRs found with review comments to process.

To review a specific PR, provide the \`pr\` argument.`;
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
  description: 'Autonomous multi-agent PR review. Spawns parallel workers to process all comments until ready for merge.',
  arguments: [
    {
      name: 'owner',
      description: 'Repository owner (inferred from git remote if omitted)',
      required: false
    },
    {
      name: 'repo',
      description: 'Repository name (inferred from git remote if omitted)',
      required: false
    },
    {
      name: 'pr',
      description: 'PR number. Omit to process all open PRs with comments.',
      required: false
    },
    {
      name: 'workers',
      description: 'Number of parallel workers (default: 3)',
      required: false
    }
  ]
};
