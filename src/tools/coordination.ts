import { getOctokit } from '../github/octokit.js';
import { GitHubClient, StructuredError } from '../github/client.js';
import { logger } from '../logging.js';
import { stateManager } from '../coordination/state.js';
import {
  ClaimWorkSchema,
  ReportProgressSchema,
  GetWorkStatusSchema,
  ResetCoordinationSchema,
  ProgressUpdateSchema,
  ProgressCheckSchema,
  type FilePartition,
  type ClaimWorkInput,
  type ReportProgressInput,
  type GetWorkStatusInput,
  type ResetCoordinationInput,
  type ProgressUpdateInput,
  type ProgressCheckInput
} from '../coordination/types.js';
import { fetchAllThreads } from './shared.js';
import { SEVERITY_ORDER, type Severity } from '../extractors/severity.js';
import { detectReviewedAgents } from '../agents/detector.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Threshold for auto-force replacement of old runs (5 minutes)
 * Workers typically complete quickly, so runs older than this are likely stale
 */
const OLD_RUN_THRESHOLD_MS = 5 * 60 * 1000;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Compare severities to find the higher one (lower index in SEVERITY_ORDER is higher severity)
 */
function maxSeverity(s1: Severity, s2: Severity): Severity {
  const i1 = SEVERITY_ORDER.indexOf(s1);
  const i2 = SEVERITY_ORDER.indexOf(s2);
  // If not found, treat as lowest priority (end of list)
  const idx1 = i1 === -1 ? SEVERITY_ORDER.length : i1;
  const idx2 = i2 === -1 ? SEVERITY_ORDER.length : i2;
  return idx1 < idx2 ? s1 : s2;
}

/**
 * Group comments by file and create partitions
 * Shared logic used by initializeRun and refreshPartitions
 */
function createPartitionsFromComments(
  comments: Array<{ file?: string; threadId: string; severity: string }>
): FilePartition[] {
  // Group by file
  const fileGroups = new Map<string, { threadIds: Set<string>, severity: Severity }>();

  for (const comment of comments) {
    if (!comment.file) continue;

    const existingGroup = fileGroups.get(comment.file);
    const group = existingGroup ?? {
      threadIds: new Set<string>(),
      severity: comment.severity as Severity
    };

    group.threadIds.add(comment.threadId);

    if (existingGroup) {
      group.severity = maxSeverity(group.severity, comment.severity as Severity);
    }

    fileGroups.set(comment.file, group);
  }

  // Create partitions
  const partitions: FilePartition[] = Array.from(fileGroups.entries()).map(([file, data]) => ({
    file,
    comments: Array.from(data.threadIds),
    severity: data.severity,
    status: 'pending' as const
  }));

  // Sort by severity (highest first)
  partitions.sort((a, b) => {
    const i1 = SEVERITY_ORDER.indexOf(a.severity);
    const i2 = SEVERITY_ORDER.indexOf(b.severity);
    const idx1 = i1 === -1 ? SEVERITY_ORDER.length : i1;
    const idx2 = i2 === -1 ? SEVERITY_ORDER.length : i2;
    return idx1 - idx2;
  });

  return partitions;
}

/**
 * Initialize a new run by fetching PR data
 */
async function initializeRun(
  client: GitHubClient,
  owner: string,
  repo: string,
  pr: number
): Promise<string> {
  const octokit = getOctokit();

  // 1. Fetch PR data and threads in parallel
  const [prResponse, threadsResponse] = await Promise.all([
    octokit.pulls.get({ owner, repo, pull_number: pr }),
    fetchAllThreads(client, owner, repo, pr, {
      filter: { resolved: false },
      maxItems: 500 // Reasonable limit
    })
  ]);
  const headSha = prResponse.data.head.sha;
  const { comments } = threadsResponse;

  // 2. Group by file and create partitions
  const partitions = createPartitionsFromComments(comments);

  // 3. Init run
  return stateManager.initRun({ owner, repo, pr }, headSha, partitions);
}

/**
 * Refresh partitions by fetching current unresolved comments
 * and adding new files that aren't already in the run.
 * This handles comments added by review agents AFTER the initial run started.
 */
async function refreshPartitions(
  client: GitHubClient,
  owner: string,
  repo: string,
  pr: number
): Promise<number> {
  // Fetch current unresolved comments
  const { comments } = await fetchAllThreads(client, owner, repo, pr, {
    filter: { resolved: false },
    maxItems: 500
  });

  // Group by file and create partitions
  const newPartitions = createPartitionsFromComments(comments);

  // Add new comments/partitions to the existing run
  return stateManager.addPartitions(newPartitions);
}

// ============================================================================
// Tool Implementations
// ============================================================================

export async function prClaimWork(
  input: ClaimWorkInput,
  client: GitHubClient
) {
  const { agent_id, pr_info, force } = input;

  const isActive = stateManager.isRunActive();
  const currentRun = stateManager.getCurrentRun();

  // Determine if we need to initialize a new run
  let needsInit = false;

  if (!currentRun) {
    // No run at all - need pr_info to start
    if (!pr_info) {
      throw new StructuredError(
        'not_found',
        'No active coordination run. Provide pr_info to start a new run.',
        false
      );
    }
    needsInit = true;
  } else if (pr_info) {
    // Run exists, pr_info provided - check if it's a different PR
    const curr = currentRun.prInfo;
    const isDifferentPR =
      curr.owner !== pr_info.owner ||
      curr.repo !== pr_info.repo ||
      curr.pr !== pr_info.pr;

    if (isDifferentPR) {
      // Different PR requested
      // Check if truly active (no completedAt) vs. reopened by refresh
      const hasCompletedAt = !!currentRun.completedAt;

      // Auto-allow replacement if run is old (>5 minutes) - workers complete quickly
      const runAge = stateManager.getRunAge();
      const autoForce = (runAge && runAge > OLD_RUN_THRESHOLD_MS) || hasCompletedAt;

      if (isActive && !force && !autoForce) {
        // Current run is still active - cannot replace (unless forced or old/completed)
        throw new StructuredError(
          'permission',
          `Active run exists for ${curr.owner}/${curr.repo}#${curr.pr}, cannot claim for different PR. Use force=true to override.`,
          false
        );
      }
      // Current run completed OR force=true OR old run - safe to replace
      if ((force || autoForce) && isActive) {
        const reason = hasCompletedAt ? 'previously completed' : 'old';
        logger.warning(`[coordination] Force-replacing active run ${currentRun.runId} (${reason}) for ${curr.owner}/${curr.repo}#${curr.pr}`);
      }
      needsInit = true;
    }
  } else if (!isActive) {
    // Run exists but completed, no pr_info - error
    throw new StructuredError(
      'not_found',
      'No active coordination run. Provide pr_info to start a new run.',
      false
    );
  }

  if (needsInit) {
    await initializeRun(client, pr_info!.owner, pr_info!.repo, pr_info!.pr);
  }

  let partition = stateManager.claimPartition(agent_id);

  // If no partition available, check if we should refresh with new unresolved comments
  // This handles comments added by review agents AFTER the initial run started
  if (!partition && stateManager.allPartitionsDone()) {
    const run = stateManager.getCurrentRun();
    if (run) {
      const { owner, repo, pr } = run.prInfo;
      const touchedPartitionsCount = await refreshPartitions(client, owner, repo, pr);

      if (touchedPartitionsCount > 0) {
        logger.warning(`[coordination] Refreshed partitions - added/updated ${touchedPartitionsCount} partitions`);
        // Try to claim again after refresh
        partition = stateManager.claimPartition(agent_id);
      }
    }
  }

  if (!partition) {
    return {
      status: 'no_work',
      message: 'No pending partitions available.'
    };
  }

  return {
    status: 'claimed',
    partition
  };
}

export async function prReportProgress(
  input: ReportProgressInput
): Promise<
  | { status: 'error'; message: string }
  | { status: 'success'; file: string; new_status: 'done' | 'failed' | 'skipped' }
> {
  const { agent_id, file, status, result } = input;

  const success = stateManager.reportProgress(agent_id, file, status, result);

  if (!success) {
    return {
      status: 'error',
      message: 'Failed to report progress. Partition may not be claimed by this agent or run is not active.'
    };
  }

  return {
    status: 'success',
    file,
    new_status: status === 'skipped' ? 'done' : status
  };
}

export async function prGetWorkStatus(
  input: GetWorkStatusInput,
  client: GitHubClient
) {
  // We currently ignore run_id in input as we only support singleton active run
  const { active, ...status } = stateManager.getStatus();
  const isActive = stateManager.isRunActive();
  const runAge = stateManager.getRunAge();

  // Check for pending AI reviewers if we have an active run with PR info
  let pendingAgents: string[] = [];
  let reviewedAgents: string[] = [];
  
  if (status.prInfo) {
    const { owner, repo, pr } = status.prInfo;
    const detection = await detectReviewedAgents(client, owner, repo, pr);
    pendingAgents = [...detection.pending];
    reviewedAgents = [...detection.reviewed];
  }

  return {
    ...status,
    isActive,
    runAge,
    pendingAgents,
    reviewedAgents,
    // Convenience flag: true only when all partitions done AND no pending agents
    isFullyComplete: !isActive && pendingAgents.length === 0 && status.prInfo !== undefined
  };
}

export async function prResetCoordination(
  input: ResetCoordinationInput
) {
  // Validate confirm field
  if (!input.confirm) {
    throw new StructuredError(
      'permission',
      'Must explicitly confirm reset by passing confirm=true',
      false
    );
  }

  const currentRun = stateManager.getCurrentRun();
  const wasActive = stateManager.isRunActive();

  stateManager.resetRun();

  return {
    status: 'reset',
    previousRun: currentRun ? {
      runId: currentRun.runId,
      pr: `${currentRun.prInfo.owner}/${currentRun.prInfo.repo}#${currentRun.prInfo.pr}`,
      wasActive,
      completedAt: currentRun.completedAt
    } : null
  };
}

export async function prProgressUpdate(
  input: ProgressUpdateInput
) {
  stateManager.updateOrchestratorPhase(input.phase, input.detail);
  return { status: 'ok', phase: input.phase, detail: input.detail };
}

export async function prProgressCheck(
  _input: ProgressCheckInput
) {
  const progress = stateManager.getOrchestratorProgress();
  const status = stateManager.getStatus();
  return {
    orchestrator: progress,
    run: {
      active: stateManager.isRunActive(),
      progress: status.progress,
      total: status.total,
      agents: (status as any).agents?.length,
      completedAt: status.completedAt
    }
  };
}

// Export schemas for registration
export {
  ClaimWorkSchema, ReportProgressSchema, GetWorkStatusSchema, ResetCoordinationSchema,
  ProgressUpdateSchema, ProgressCheckSchema
};
