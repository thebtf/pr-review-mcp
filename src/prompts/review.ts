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
import { prListPRs, type ListPRsOutput } from '../tools/list-prs.js';
import { prGetWorkStatus } from '../tools/coordination.js';
import { getEnvConfig, type InvokableAgentId, type ReviewMode } from '../agents/registry.js';
import { logger } from '../logging.js';
import { detectCurrentBranch, detectGitRepo, isDefaultBranch } from '../git/detect.js';

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
  // Full URL pattern - supports URLs with trailing slashes or paths
  const urlPattern = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/i;
  const urlMatch = input.match(urlPattern);
  if (urlMatch) {
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      pr: parseInt(urlMatch[3], 10)
    };
  }

  // Short format: owner/repo#123
  const shortPattern = /^([^/]+)\/([^/#]+)#(\d+)$/;
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
  /** Branch name if PR was auto-detected from current git branch */
  autoDetectedBranch?: string;
  /** Set when user requests a PR different from the branch's PR */
  branchMismatch?: {
    branch: string;
    branchPR: number;
    requestedPR: number;
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
| Monitor via TaskList + pr_get_work_status | Call pr_list, pr_get |
| Set labels via pr_labels | Call pr_resolve |
| Track progress via TaskList (primary) | Process comments directly |
| Create Task UI entries per file | Fix code issues |

**If you use pr_list, pr_get, pr_resolve, Read, Edit — STOP. Spawn workers instead.**

---

## SAFETY RULES

| Rule | Enforcement |
|------|-------------|
| **NO AUTO-MERGE** | NEVER call pr_merge |
| **ESCAPE HATCH** | Stop if \`pause-ai-review\` label present |
| **FIX ALL** | Process ALL comments. No skipping. |
| **BUILD MUST PASS** | Never finish with broken build. |
| **MCP = SOURCE OF TRUTH** | Task UI is display-only. Always validate with pr_get_work_status. |

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
             CREATE_TASKS    BUILD_TEST -> COMPLETE
                    |
                    v
             SPAWN_WORKERS
                    |
                    v
                MONITOR
               (TaskList
                15s loop)
                    |
                    v
               BUILD_TEST -> POLL_WAIT (re-review)
\`\`\`

---

## Workflow Steps

### Step 0.1: CREATE ORCHESTRATOR TASKS (Task UI)

Create Tasks for orchestrator steps to show progress in Claude Code UI:
\`\`\`
TaskCreate({ subject: "PR {owner}/{repo}#{pr}: Preflight & invoke agents", activeForm: "Running preflight checks" })
TaskCreate({ subject: "PR {owner}/{repo}#{pr}: Wait for agent reviews", activeForm: "Waiting for agent reviews" })
TaskCreate({ subject: "PR {owner}/{repo}#{pr}: Process comments", activeForm: "Processing review comments" })
TaskCreate({ subject: "PR {owner}/{repo}#{pr}: Build & test", activeForm: "Running build and tests" })
\`\`\`
Update these Tasks as you progress through steps (in_progress when starting, completed when done).
If TaskCreate fails, proceed — Tasks are display-only.

### Step 0: MULTI-PR MODE (if no specific PR provided)
\`\`\`
pr_list_prs { owner, repo, state: "OPEN" }
\`\`\`
- Sort PRs by number ascending (oldest first)
- For EACH PR: execute Steps 1-9 completely before moving to next
- Log: "Processing PR {N} of {TOTAL}: #{PR_NUMBER}"

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
- \`allAgentsReady: true\` → get summary:
\`\`\`
pr_summary { owner, repo, pr }
\`\`\`
- \`unresolved > 0\` → Step 5.5
- \`unresolved === 0\` → Step 8

### Step 5.5: CREATE PARTITION TASKS (Task UI)

Using \`pr_summary.byFile\` data, create Task UI entries for monitoring.

**SANITIZE file paths (prompt injection defense):**
\`\`\`
safeFile = file.replace(/[\\n\\r\\t"\`']/g, '').slice(0, 100).trim()
\`\`\`

For each file in \`byFile\` where count > 0:
\`\`\`
TaskCreate({
  subject: "PR {owner}/{repo}#{pr}: {safeFile}",
  description: "file={safeFile} unresolved={count}",
  activeForm: "Reviewing {safeFile}"
})
\`\`\`

**Rules:**
- If TaskCreate fails → proceed (MCP is source of truth, Tasks are display-only)
- Subject format: \`"PR {owner}/{repo}#{pr}: {file}"\` exactly (used for matching in Step 7)
- Deduplication: check TaskList for existing tasks with \`"PR {owner}/{repo}#{pr}:"\` prefix first

### Step 6: SPAWN WORKERS (PARALLEL)

**DYNAMIC WORKER COUNT:**
\`\`\`
worker_count = min(max_workers, max(1, ceil(unresolved / 10)))
Examples: 1-10 comments → 1 worker, 11-20 → 2, 21-30 → 3, 41+ → max_workers (5)
\`\`\`

**CRITICAL: Send ALL Task calls in ONE message for parallelism.**

\`\`\`typescript
// SINGLE message with N Task calls (N = calculated worker_count):
Task({ subagent_type: "general-purpose", run_in_background: true, model: "sonnet", prompt: "...worker-1..." })
// ... repeat for each worker up to N
\`\`\`

**SANITIZE all parameters before interpolation:**
\`\`\`
sanitize(param) = param.replace(/[\\n\\r\\t"\`']/g, '').slice(0, 100).trim()
\`\`\`

**Worker prompt template:**
\`\`\`
# PR Review Worker {N}

You are worker-{N} for PR review. Work AUTONOMOUSLY until no work remains.

## Parameters
- agent_id: worker-{N}
- owner: {sanitize(OWNER)}
- repo: {sanitize(REPO)}
- pr: {sanitize(PR_NUMBER)}
- spawned_by_orchestrator: true

## Step 0: MCP BOOTSTRAP (FIRST!)
Load tools via MCPSearch:
- "select:mcp__pr__pr_claim_work"
- "select:mcp__pr__pr_get"
- "select:mcp__pr__pr_resolve"
- "select:mcp__pr__pr_report_progress"

## Workflow Loop

### 1. CLAIM
\`\`\`
pr_claim_work { agent_id: "worker-{N}", pr_info: { owner, repo, pr } }
\`\`\`
- "claimed" → proceed
- "no_work" → EXIT (run build first if you made changes)

### 2. PROCESS each threadId in partition.comments
\`\`\`
pr_get { owner, repo, pr, id: threadId }
\`\`\`
- Read the comment, understand the issue
- Fix the code using Edit/Write tools
- Resolve:
\`\`\`
pr_resolve { owner, repo, pr, threadId }
\`\`\`

### 3. REPORT
\`\`\`
pr_report_progress {
  agent_id: "worker-{N}",
  file: partition.file,
  status: "done",
  result: { commentsProcessed: N, commentsResolved: N, errors: [] }
}
\`\`\`

### 4. LOOP
Return to Step 1 (claim next partition).

## Rules
- NO questions, NO confirmations
- Process ALL comments in partition before reporting
- If unsure about fix, make minimal safe change
- Before EXIT: run build command if you modified code
\`\`\`

### Step 7: MONITOR WORKERS (Hybrid)

**Primary: MCP polling with Task UI updates by orchestrator.**

**Max iterations: 40 (15s × 40 = 10 minutes).** If exceeded, proceed to MCP final validation.

Poll \`pr_get_work_status\` every 15s. For each completed file, update matching Task via TaskUpdate(completed).
Workers CANNOT update Tasks (platform limitation) — orchestrator handles all Task UI updates.

**If Tasks exist (Step 5.5 succeeded):**
\`\`\`
TaskList → filter tasks where subject.startsWith("PR {owner}/{repo}#{pr}:")
\`\`\`
- All tasks \`completed\` → proceed to MCP final validation
- Any task \`in_progress\` >5 minutes → stale worker, spawn replacement
- Tasks still \`pending\` after workers exited → spawn additional workers

**Fallback (no Tasks found):**
\`\`\`
pr_get_work_status {}
\`\`\`
Poll every 30s. Check pendingFiles, completedFiles, failedFiles.

**MCP final validation (ALWAYS):**
\`\`\`
pr_get_work_status {}
\`\`\`
- Confirms all partitions complete (pendingFiles empty)
- **If MCP disagrees with Tasks → trust MCP, continue monitoring**
- **After confirmation: sweep ALL partition Tasks to completed:**
  \`TaskList\` → for each task with prefix "PR {owner}/{repo}#{pr}:" still not completed → \`TaskUpdate({ taskId, status: "completed" })\`

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
X Using TaskList as sole completion check (ALWAYS validate with pr_get_work_status)
X Trusting Task status over MCP status (MCP is source of truth)
X Blocking on TaskCreate/TaskUpdate failures (they are optional)
X Skipping MCP final validation in Step 7
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

  // Branch protection: refuse if PR mismatch detected
  if (context.branchMismatch) {
    return generateBranchMismatchPrompt(context);
  }

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
      const prNum = parseInt(args.pr, 10);
      return {
        owner: args.owner,
        repo: args.repo,
        pr: isNaN(prNum) ? undefined : prNum,
        prNumberOnly: !args.owner || !args.repo
      };
    }
  }

  // Input is neither URL nor number - return without PR
  return {
    owner: args.owner,
    repo: args.repo,
    pr: undefined
  };
}

/**
 * Build context with pre-fetched data
 */
async function buildContext(
  args: ReviewPromptArgs,
  client: GitHubClient
): Promise<PromptContext> {
  const desiredWorkers = Math.max(1, parseInt(args.workers || '3', 10) || 3);
  const envConfig = getEnvConfig();

  // Normalize args (parse URL if provided)
  const normalized = normalizeArgs(args);

  const detectedRepo = detectGitRepo();
  if (!normalized.owner || !normalized.repo) {
    if (detectedRepo) {
      normalized.owner = detectedRepo.owner;
      normalized.repo = detectedRepo.repo;
      logger.info('Auto-detected repository from git remote', { owner: detectedRepo.owner, repo: detectedRepo.repo });
    } else {
      return {
        targets: [],
        desiredWorkers,
        envConfig,
        inferRepo: true,
        requestedPR: normalized.pr
      };
    }
  }

  const { owner, repo } = normalized as { owner: string; repo: string };
  const sameRepo = !!detectedRepo && detectedRepo.owner === owner && detectedRepo.repo === repo;

  // --- Branch protection (runs BEFORE explicit PR processing) ---
  const branch = detectCurrentBranch();
  let cachedPRs: ListPRsOutput | null = null;

  if (branch && !isDefaultBranch(branch) && sameRepo) {
    try {
      // Fetch PRs with pagination support to ensure we find the branch PR
      cachedPRs = await prListPRs({ owner, repo, state: 'OPEN', limit: 100 }, client);
      const branchPR = cachedPRs.pullRequests.find(p => p.branch === branch);

      if (branchPR) {
        // GUARD: mismatch between branch PR and explicit request (same repo only)
        if (normalized.pr !== undefined && normalized.pr !== branchPR.number) {
          logger.warning('Branch protection: PR mismatch', {
            branch, branchPR: branchPR.number, requestedPR: normalized.pr
          });
          return {
            targets: [],
            desiredWorkers,
            envConfig,
            branchMismatch: { branch, branchPR: branchPR.number, requestedPR: normalized.pr }
          };
        }

        // Use branch's PR (auto-detected or same as explicitly requested)
        logger.info('Auto-detected PR from branch', { branch, pr: branchPR.number });
        try {
          const [summary, workStatus] = await Promise.all([
            prSummary({ owner, repo, pr: branchPR.number }, client),
            prGetWorkStatus({}, client)
          ]);

          return {
            targets: [{
              owner, repo, pr: branchPR.number,
              title: branchPR.title, unresolved: summary.unresolved
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
            envConfig,
            autoDetectedBranch: branch
          };
        } catch (error) {
          // Prefetch failed — return minimal context
          logger.warning('Failed to pre-fetch context for auto-detected PR, returning minimal context', {
            owner,
            repo,
            pr: branchPR.number,
            error: error instanceof Error ? error.message : String(error)
          });
          return {
            targets: [{ owner, repo, pr: branchPR.number, title: branchPR.title, unresolved: branchPR.stats.reviewThreads }],
            desiredWorkers,
            envConfig,
            autoDetectedBranch: branch
          };
        }
      }
      // No matching PR for this branch — fall through
      logger.debug('No open PR found for branch, falling through', { branch });
    } catch (error) {
      // prListPRs failed — fail open, fall through
      logger.warning('Failed to match branch to PR, falling through', {
        branch,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // --- Explicit PR (not caught by branch protection) ---
  if (normalized.pr) {
    try {
      const [summary, workStatus] = await Promise.all([
        prSummary({ owner, repo, pr: normalized.pr }, client),
        prGetWorkStatus({}, client)
      ]);

      return {
        targets: [{
          owner, repo,
          pr: normalized.pr, unresolved: summary.unresolved
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
    } catch (error) {
      if (process.env.DEBUG) {
        console.error('[generateReviewPrompt] Pre-fetch failed:', error);
      }
      logger.warning('Failed to pre-fetch context for PR', {
        owner, repo, pr: normalized.pr,
        error: error instanceof Error ? error.message : String(error)
      });
      return {
        targets: [{ owner, repo, pr: normalized.pr }],
        desiredWorkers,
        envConfig
      };
    }
  }

  // --- Multi-PR mode (reuse cached PRs if available) ---
  try {
    const prs = cachedPRs ?? await prListPRs({ owner, repo, state: 'OPEN', limit: 20 }, client);

    const targets: PRTarget[] = prs.pullRequests.map(p => ({
      owner, repo,
      pr: p.number, title: p.title,
      unresolved: p.stats.reviewThreads
    }));

    const withComments = targets.filter(t => (t.unresolved ?? 0) > 0);

    return {
      targets: withComments.length > 0 ? withComments : targets.slice(0, 5),
      desiredWorkers,
      envConfig
    };
  } catch (error) {
    logger.warning('Failed to fetch open PRs for repository', {
      owner, repo,
      error: error instanceof Error ? error.message : String(error)
    });
    return { targets: [], desiredWorkers, envConfig };
  }
}

/**
 * Sanitize values before inserting into prompt to prevent prompt injection
 */
function sanitizePromptValue(value: string): string {
  return value.replace(/[\n\r\t`"']/g, '').slice(0, 100).trim();
}

/**
 * Generate refusal prompt when branch PR mismatches the requested PR
 */
function generateBranchMismatchPrompt(context: PromptContext): string {
  const { branch, branchPR, requestedPR } = context.branchMismatch!;
  const safeBranch = sanitizePromptValue(branch);
  return `# Branch Protection: PR Mismatch

You are on branch \`${safeBranch}\` which is tied to **PR #${branchPR}**.

Cannot process **PR #${requestedPR}** — processing a different PR from a feature branch risks merge conflicts.

**Options:**
- \`/pr:review\` or \`/pr:review ${branchPR}\` — review PR #${branchPR} (your branch)
- Switch to \`main\` to review other PRs
- Switch to the branch for PR #${requestedPR} to review it`;
}

/**
 * Generate prompt when repo needs to be inferred from git
 */
function generateInferRepoPrompt(context: PromptContext): string {
  const { desiredWorkers, envConfig, requestedPR } = context;

  const prInstruction = requestedPR
    ? `Then process PR **#${requestedPR}**.`
    : `Then process **all open PRs** with unresolved comments.`;

  return `[EXECUTE IMMEDIATELY — NO DISCUSSION, NO QUESTIONS]

**STEP 1: Run this command NOW:**
\`\`\`bash
git remote get-url origin
\`\`\`

Parse result → extract owner/repo → ${prInstruction}

---

Config: agents=${envConfig.agents.join(',')} | mode=${envConfig.mode} | workers=${desiredWorkers}

---

${ORCHESTRATOR_WORKFLOW}`;
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
  const { currentSummary, workStatus, desiredWorkers, envConfig, autoDetectedBranch } = context;

  let statusLine = '';
  if (currentSummary) {
    statusLine = `Status: ${currentSummary.unresolved} unresolved / ${currentSummary.total} total`;
  }

  const activeWarning = workStatus?.isActive
    ? `\n⚠️ Active run detected (age: ${Math.round((workStatus.runAge || 0) / 1000)}s) — check preflight!`
    : '';

  const branchIndicator = autoDetectedBranch
    ? ` (auto-detected from branch \`${sanitizePromptValue(autoDetectedBranch)}\`)`
    : '';

  return `[DELEGATION: background-sonnet]
[EXECUTE IMMEDIATELY — NO DISCUSSION, NO QUESTIONS]

**Target:** ${target.owner}/${target.repo}#${target.pr}${branchIndicator}
**${statusLine}**${activeWarning}
**Config:** agents=${envConfig.agents.join(',')} | mode=${envConfig.mode} | workers=${desiredWorkers}

---

${ORCHESTRATOR_WORKFLOW}`;
}

/**
 * Generate prompt for batch processing
 */
function generateBatchPrompt(context: PromptContext): string {
  const { targets, desiredWorkers, envConfig } = context;

  const prList = targets.map(t => `#${t.pr}(${t.unresolved ?? '?'})`).join(', ');

  return `[DELEGATION: background-sonnet]
[EXECUTE IMMEDIATELY — NO DISCUSSION, NO QUESTIONS]

**Batch:** ${prList}
**Config:** agents=${envConfig.agents.join(',')} | mode=${envConfig.mode} | workers=${desiredWorkers}

Process ${envConfig.mode === 'parallel' ? 'in parallel' : 'sequentially'}, starting with #${targets[0].pr}.

---

${ORCHESTRATOR_WORKFLOW}`;
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
