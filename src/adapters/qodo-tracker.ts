/**
 * Qodo Tracker - Manages a separate tracker comment for Qodo issue resolution
 *
 * Since Qodo uses a "persistent issue comment" that can't be resolved via
 * GitHub's resolveThread API, we create a separate tracker comment with
 * checkboxes to track resolution status.
 */

import { getOctokit } from '../github/octokit.js';
import { StructuredError } from '../github/client.js';
import type { QodoReview, QodoComment } from './qodo.js';
import { qodoToNormalizedComments } from './qodo.js';

// ============================================================================
// Constants
// ============================================================================

const TRACKER_MARKER = '<!-- pr-review-mcp-tracker -->';
const TRACKER_TITLE = '## 🎯 Qodo Issue Tracker';
const OUR_BOT_MARKER = 'pr-review-mcp'; // Used to identify our comments

// ============================================================================
// Types
// ============================================================================

export interface TrackerItem {
  id: string;
  resolved: boolean;
  severity: string;
  title: string;
  file: string;
  line: number | null;
}

export interface TrackerState {
  commentId: number | null;
  commentUrl: string | null;
  items: TrackerItem[];
  lastSynced: string;
  qodoCommentId: number;
}

// ============================================================================
// Parsing Functions
// ============================================================================

/**
 * Parse tracker comment body into state
 */
function parseTrackerBody(body: string): Map<string, boolean> {
  const items = new Map<string, boolean>();

  // Match pattern: - [x] <!-- qodo:id --> or - [ ] <!-- qodo:id -->
  const regex = /- \[(x| )\] <!-- qodo:([^\s]+) -->/g;
  let match;

  while ((match = regex.exec(body)) !== null) {
    const resolved = match[1] === 'x';
    const id = `qodo-${match[2]}`; // Reconstruct full ID
    items.set(id, resolved);
  }

  return items;
}

/**
 * Generate tracker comment body from items
 */
function generateTrackerBody(
  items: TrackerItem[],
  qodoCommentId: number,
  owner: string,
  repo: string,
  pr: number
): string {
  const lines: string[] = [
    TRACKER_MARKER,
    TRACKER_TITLE,
    ''
  ];

  // Group by severity
  const bySevertiy = new Map<string, TrackerItem[]>();
  for (const item of items) {
    const list = bySevertiy.get(item.severity) || [];
    list.push(item);
    bySevertiy.set(item.severity, list);
  }

  // Order: CRIT, MAJOR, MINOR, N/A
  const order = ['CRIT', 'MAJOR', 'MINOR', 'N/A'];

  for (const severity of order) {
    const severityItems = bySevertiy.get(severity);
    if (!severityItems || severityItems.length === 0) continue;

    for (const item of severityItems) {
      const checkbox = item.resolved ? '[x]' : '[ ]';
      // Extract suffix for shorter ID in comment
      const idSuffix = item.id.replace('qodo-', '');
      const location = item.file ? ` (${item.file}${item.line ? `:${item.line}` : ''})` : '';

      lines.push(`- ${checkbox} <!-- qodo:${idSuffix} --> **${severity}** ${item.title}${location}`);
    }
  }

  lines.push('');
  lines.push(`_Last synced: ${new Date().toISOString()} | [Qodo review](https://github.com/${owner}/${repo}/pull/${pr}#issuecomment-${qodoCommentId})_`);

  return lines.join('\n');
}

// ============================================================================
// GitHub API Functions
// ============================================================================

/**
 * Fetch our tracker comment from the PR
 */
export async function fetchTrackerComment(
  owner: string,
  repo: string,
  pr: number
): Promise<{ id: number; body: string; url: string } | null> {
  try {
    const octokit = getOctokit();
    const comments = await octokit.paginate(
      octokit.issues.listComments,
      { owner, repo, issue_number: pr, per_page: 100 }
    );

    // Find all tracker comments
    const trackers: { id: number; body: string; url: string }[] = [];
    for (const comment of comments) {
      if (comment.body?.includes(TRACKER_MARKER)) {
        trackers.push({
          id: comment.id,
          body: comment.body,
          url: comment.html_url
        });
      }
    }

    if (trackers.length === 0) return null;

    // Return the OLDEST tracker (lowest ID) for consistency
    trackers.sort((a, b) => a.id - b.id);
    return trackers[0];
  } catch {
    return null;
  }
}

/**
 * Delete a tracker comment by ID
 */
export async function deleteTrackerComment(
  owner: string,
  repo: string,
  commentId: number
): Promise<void> {
  try {
    const octokit = getOctokit();
    await octokit.issues.deleteComment({
      owner,
      repo,
      comment_id: commentId
    });
  } catch {
    // Ignore deletion errors (comment may already be deleted)
  }
}

/**
 * Find and delete duplicate tracker comments, keeping the oldest one
 */
export async function cleanupDuplicateTrackers(
  owner: string,
  repo: string,
  pr: number
): Promise<{ kept: number | null; deleted: number[] }> {
  try {
    const octokit = getOctokit();
    const comments = await octokit.paginate(
      octokit.issues.listComments,
      { owner, repo, issue_number: pr, per_page: 100 }
    );

    // Find all tracker comment IDs
    const ids: number[] = [];
    for (const comment of comments) {
      if (comment.body?.includes(TRACKER_MARKER)) {
        ids.push(comment.id);
      }
    }

    if (ids.length <= 1) {
      return { kept: ids[0] || null, deleted: [] };
    }

    // Sort by ID (oldest first)
    ids.sort((a, b) => a - b);

    const kept = ids[0];
    const toDelete = ids.slice(1);

    // Delete duplicates
    for (const id of toDelete) {
      await deleteTrackerComment(owner, repo, id);
    }

    return { kept, deleted: toDelete };
  } catch {
    return { kept: null, deleted: [] };
  }
}

/**
 * Create a new tracker comment
 */
export async function createTrackerComment(
  owner: string,
  repo: string,
  pr: number,
  body: string
): Promise<{ id: number; url: string }> {
  try {
    const octokit = getOctokit();
    const { data } = await octokit.issues.createComment({
      owner,
      repo,
      issue_number: pr,
      body
    });

    return {
      id: data.id,
      url: data.html_url
    };
  } catch (e) {
    throw new StructuredError(
      'network',
      `Failed to create tracker comment: ${e instanceof Error ? e.message : 'Unknown error'}`,
      true
    );
  }
}

/**
 * Update an existing tracker comment
 */
export async function updateTrackerComment(
  owner: string,
  repo: string,
  commentId: number,
  body: string
): Promise<void> {
  try {
    const octokit = getOctokit();
    await octokit.issues.updateComment({
      owner,
      repo,
      comment_id: commentId,
      body
    });
  } catch (e) {
    throw new StructuredError(
      'network',
      `Failed to update tracker comment: ${e instanceof Error ? e.message : 'Unknown error'}`,
      true
    );
  }
}

// ============================================================================
// Main Functions
// ============================================================================

/**
 * Get or create tracker state for a PR
 */
export async function getTrackerState(
  owner: string,
  repo: string,
  pr: number,
  qodoReview: QodoReview
): Promise<TrackerState> {
  // Fetch existing tracker comment
  const existing = await fetchTrackerComment(owner, repo, pr);

  // Parse Qodo issues
  const qodoComments = qodoToNormalizedComments(qodoReview);

  if (existing) {
    // Parse existing state and merge with current Qodo issues
    const resolvedMap = parseTrackerBody(existing.body);

    const items: TrackerItem[] = qodoComments.map(qc => ({
      id: qc.id,
      resolved: resolvedMap.get(qc.id) || false, // Preserve resolved state
      severity: qc.severity,
      title: qc.title,
      file: qc.file,
      line: qc.line
    }));

    return {
      commentId: existing.id,
      commentUrl: existing.url,
      items,
      lastSynced: new Date().toISOString(),
      qodoCommentId: qodoReview.commentId
    };
  }

  // No tracker exists - create initial state (all unresolved)
  const items: TrackerItem[] = qodoComments.map(qc => ({
    id: qc.id,
    resolved: false,
    severity: qc.severity,
    title: qc.title,
    file: qc.file,
    line: qc.line
  }));

  return {
    commentId: null,
    commentUrl: null,
    items,
    lastSynced: new Date().toISOString(),
    qodoCommentId: qodoReview.commentId
  };
}

/**
 * Toggle resolution status of a Qodo issue
 * Returns updated tracker state
 */
export async function toggleQodoIssue(
  owner: string,
  repo: string,
  pr: number,
  qodoReview: QodoReview,
  issueId: string,
  resolved: boolean
): Promise<TrackerState> {
  // Get current state (creates if needed)
  const state = await getTrackerState(owner, repo, pr, qodoReview);

  console.error(`[tracker] state.commentId=${state.commentId}, items=${state.items.length}`);

  // Find the issue
  const item = state.items.find(i => i.id === issueId || i.id.endsWith(issueId));
  if (!item) {
    throw new StructuredError('not_found', `Qodo issue ${issueId} not found`, false);
  }

  console.error(`[tracker] Found item: ${item.id}, current resolved=${item.resolved}, setting to ${resolved}`);

  // Update status
  item.resolved = resolved;

  // Generate new body
  const body = generateTrackerBody(state.items, qodoReview.commentId, owner, repo, pr);

  // Always re-fetch to find ANY existing tracker (handles duplicates)
  const latest = await fetchTrackerComment(owner, repo, pr);
  console.error(`[tracker] Check: latest=${latest?.id}, state.commentId=${state.commentId}`);

  if (latest) {
    // Merge any changes made by others
    const latestResolved = parseTrackerBody(latest.body);
    console.error(`[tracker] Merging ${latestResolved.size} items from latest`);
    for (const i of state.items) {
      if (i.id !== item.id) {
        // Preserve others' changes
        i.resolved = latestResolved.get(i.id) || i.resolved;
      }
    }
    // Regenerate with merged state
    const mergedBody = generateTrackerBody(state.items, qodoReview.commentId, owner, repo, pr);
    console.error(`[tracker] Updating comment ${latest.id}`);
    await updateTrackerComment(owner, repo, latest.id, mergedBody);
    state.commentId = latest.id;
    state.commentUrl = latest.url;
  } else {
    // No tracker exists - create new
    console.error(`[tracker] No tracker found, creating new`);
    const created = await createTrackerComment(owner, repo, pr, body);
    state.commentId = created.id;
    state.commentUrl = created.url;
  }

  state.lastSynced = new Date().toISOString();
  return state;
}

/**
 * Sync tracker with current Qodo state (add new issues, remove stale ones)
 */
export async function syncTracker(
  owner: string,
  repo: string,
  pr: number,
  qodoReview: QodoReview
): Promise<TrackerState> {
  const state = await getTrackerState(owner, repo, pr, qodoReview);

  // If no tracker exists yet, don't create one until first resolve
  if (!state.commentId) {
    return state;
  }

  // Regenerate body with current Qodo issues
  const body = generateTrackerBody(state.items, qodoReview.commentId, owner, repo, pr);
  await updateTrackerComment(owner, repo, state.commentId, body);

  return state;
}
