import { z } from 'zod';
import { getOctokit } from '../github/octokit.js';
import { GitHubClient, StructuredError } from '../github/client.js';
import { stateManager } from '../coordination/state.js';
import { 
  ClaimWorkSchema, 
  ReportProgressSchema, 
  GetWorkStatusSchema,
  type FilePartition,
  type ClaimWorkInput,
  type ReportProgressInput,
  type GetWorkStatusInput
} from '../coordination/types.js';
import { fetchAllThreads } from './shared.js';
import { SEVERITY_ORDER, type Severity } from '../extractors/severity.js';

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
 * Initialize a new run by fetching PR data
 */
async function initializeRun(
  client: GitHubClient,
  owner: string,
  repo: string,
  pr: number
): Promise<string> {
  const octokit = getOctokit();

  // 1. Get PR head SHA
  const { data: prData } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: pr
  });
  const headSha = prData.head.sha;

  // 2. Fetch all unresolved threads
  // We focus on unresolved threads for "work"
  const { comments } = await fetchAllThreads(client, owner, repo, pr, {
    filter: { resolved: false },
    maxItems: 500 // Reasonable limit
  });

  // 3. Group by file
  const fileGroups = new Map<string, { comments: Set<string>, severity: Severity }>();

  for (const comment of comments) {
    if (!comment.file) continue;

    const group = fileGroups.get(comment.file) || { comments: new Set(), severity: 'N/A' };

    // Track unique thread IDs (O(1) with Set vs O(N) with Array.includes)
    group.comments.add(comment.threadId);

    // Update max severity for the file
    // Cast comment.severity to Severity because ProcessedComment defines it as string
    group.severity = maxSeverity(group.severity, comment.severity as Severity);

    fileGroups.set(comment.file, group);
  }

  // 4. Create partitions
  const partitions: FilePartition[] = Array.from(fileGroups.entries()).map(([file, data]) => ({
    file,
    comments: Array.from(data.comments),
    severity: data.severity,
    status: 'pending'
  }));

  // Sort partitions by severity (highest first)
  partitions.sort((a, b) => {
    const i1 = SEVERITY_ORDER.indexOf(a.severity);
    const i2 = SEVERITY_ORDER.indexOf(b.severity);
    return i1 - i2;
  });

  // 5. Init run
  return stateManager.initRun({ owner, repo, pr }, headSha, partitions);
}

// ============================================================================
// Tool Implementations
// ============================================================================

export async function prClaimWork(
  input: ClaimWorkInput,
  client: GitHubClient
) {
  const { agent_id, pr_info } = input;
  
  let currentRun = stateManager.getCurrentRun();

  // Auto-create run if needed
  if (!currentRun) {
    if (!pr_info) {
      throw new StructuredError(
        'not_found',
        'No active coordination run. Provide pr_info to start a new run.',
        false  // Validation error - not retryable
      );
    }
    await initializeRun(client, pr_info.owner, pr_info.repo, pr_info.pr);
    currentRun = stateManager.getCurrentRun();
  } else if (pr_info) {
    // Verify pr_info matches current run if provided
    const curr = currentRun.prInfo;
    if (curr.owner !== pr_info.owner || curr.repo !== pr_info.repo || curr.pr !== pr_info.pr) {
      throw new StructuredError(
        'parse',
        `Active run exists for ${curr.owner}/${curr.repo}#${curr.pr}, cannot claim for different PR.`,
        false  // Validation error - not retryable
      );
    }
  }

  const partition = stateManager.claimPartition(agent_id);

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
) {
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
    new_status: status
  };
}

export async function prGetWorkStatus(
  input: GetWorkStatusInput
) {
  // We currently ignore run_id in input as we only support singleton active run
  return stateManager.getStatus();
}

// Export schemas for registration
export { ClaimWorkSchema, ReportProgressSchema, GetWorkStatusSchema };