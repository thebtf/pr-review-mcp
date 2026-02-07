/**
 * GitHub State Comment - Persistent state storage in PR comments
 *
 * Uses hidden HTML comments as markers to find/update state.
 * Format: <!-- pr-review-mcp-state:v2 --> ... <!-- /pr-review-mcp-state -->
 */

import { getOctokit, getGraphQL } from './octokit.js';
import { QUERIES } from './queries.js';
import { logger } from '../logging.js';
import type { ParentChildEntry } from '../coordination/types.js';

// ============================================================================
// Constants
// ============================================================================

const STATE_MARKER_START = '<!-- pr-review-mcp-state:v2 -->';
const STATE_MARKER_END = '<!-- /pr-review-mcp-state -->';
const STATE_VERSION = 2;

// ============================================================================
// Types
// ============================================================================

export interface PersistentState {
  version: number;
  parentChildren: Record<string, ParentChildEntry>;
  resolvedNitpicks: Record<string, { resolvedAt: string; resolvedBy: string }>;
  updatedAt: string;
}

interface StateComment {
  id: number;
  body: string;
}

// ============================================================================
// State Comment Management
// ============================================================================

/**
 * Find existing state comment in PR issue comments
 */
async function findStateComment(
  owner: string,
  repo: string,
  pr: number
): Promise<StateComment | null> {
  const octokit = getOctokit();

  try {
    // Fetch issue comments (state is stored as issue comment, not review comment)
    const comments = await octokit.paginate(
      octokit.issues.listComments,
      { owner, repo, issue_number: pr, per_page: 100 },
      (response, done) => {
        // Stop pagination if we find the state comment
        const found = response.data.find(c => c.body?.includes(STATE_MARKER_START));
        if (found) {
          done();
          return [found];
        }
        return response.data;
      }
    );

    const stateComment = comments.find(c => c.body?.includes(STATE_MARKER_START));
    if (stateComment && stateComment.body) {
      return { id: stateComment.id, body: stateComment.body };
    }

    return null;
  } catch (error) {
    logger.warning('[state-comment] Failed to find state comment', error);
    return null;
  }
}

/**
 * Parse state JSON from comment body
 */
function parseStateFromBody(body: string): PersistentState | null {
  try {
    const startIdx = body.indexOf(STATE_MARKER_START);
    const endIdx = body.indexOf(STATE_MARKER_END);

    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
      return null;
    }

    // Extract JSON from markdown code block
    const content = body.substring(startIdx + STATE_MARKER_START.length, endIdx);
    const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);

    if (!jsonMatch || !jsonMatch[1]) {
      return null;
    }

    return JSON.parse(jsonMatch[1].trim()) as PersistentState;
  } catch (error) {
    logger.warning('[state-comment] Failed to parse state from body', error);
    return null;
  }
}

/**
 * Format state as comment body
 */
function formatStateBody(state: PersistentState): string {
  const json = JSON.stringify(state, null, 2);
  return `${STATE_MARKER_START}
<details>
<summary>🤖 PR Review MCP State (auto-managed, do not edit)</summary>

\`\`\`json
${json}
\`\`\`

</details>
${STATE_MARKER_END}`;
}

/**
 * Create empty state
 */
function createEmptyState(): PersistentState {
  return {
    version: STATE_VERSION,
    parentChildren: {},
    resolvedNitpicks: {},
    updatedAt: new Date().toISOString()
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Load state from PR comment
 * Returns empty state if no comment exists
 */
export async function loadState(
  owner: string,
  repo: string,
  pr: number
): Promise<PersistentState> {
  const comment = await findStateComment(owner, repo, pr);

  if (!comment) {
    return createEmptyState();
  }

  const state = parseStateFromBody(comment.body);
  return state || createEmptyState();
}

/**
 * Save state to PR comment (create or update)
 */
export async function saveState(
  owner: string,
  repo: string,
  pr: number,
  state: PersistentState
): Promise<void> {
  const octokit = getOctokit();
  const existingComment = await findStateComment(owner, repo, pr);

  state.updatedAt = new Date().toISOString();
  const body = formatStateBody(state);

  try {
    if (existingComment) {
      // Update existing comment
      await octokit.issues.updateComment({
        owner,
        repo,
        comment_id: existingComment.id,
        body
      });
      logger.debug('[state-comment] Updated state comment', { id: existingComment.id });
    } else {
      // Create new comment
      const { data } = await octokit.issues.createComment({
        owner,
        repo,
        issue_number: pr,
        body
      });
      logger.debug('[state-comment] Created state comment', { id: data.id });
    }
  } catch (error) {
    logger.error('[state-comment] Failed to save state', error);
    throw error;
  }
}

/**
 * Add reaction to an issue comment (by numeric ID)
 */
export async function addResolvedReaction(
  owner: string,
  repo: string,
  commentId: number,
  reaction: '+1' | 'hooray' | 'heart' | 'rocket' | 'eyes' = '+1'
): Promise<boolean> {
  const octokit = getOctokit();

  try {
    await octokit.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: commentId,
      content: reaction
    });
    logger.debug('[state-comment] Added reaction to issue comment', { commentId, reaction });
    return true;
  } catch (error) {
    logger.debug('[state-comment] Failed to add reaction to issue comment', error);
    return false;
  }
}

/**
 * Map simple reaction names to GraphQL ReactionContent enum
 */
const REACTION_MAP: Record<string, string> = {
  '+1': 'THUMBS_UP',
  '-1': 'THUMBS_DOWN',
  'laugh': 'LAUGH',
  'hooray': 'HOORAY',
  'confused': 'CONFUSED',
  'heart': 'HEART',
  'rocket': 'ROCKET',
  'eyes': 'EYES'
};

/**
 * Add reaction to any GitHub node (review comment, PR review, etc.) via GraphQL
 * Works with GraphQL node IDs like PRRC_*, PRR_*, etc.
 */
export async function addReactionToNode(
  nodeId: string,
  reaction: '+1' | 'hooray' | 'heart' | 'rocket' | 'eyes' = '+1'
): Promise<boolean> {
  const graphql = getGraphQL();
  const reactionContent = REACTION_MAP[reaction] || 'THUMBS_UP';

  try {
    await graphql(QUERIES.addReaction, {
      subjectId: nodeId,
      content: reactionContent
    });
    logger.debug('[state-comment] Added reaction to node via GraphQL', { nodeId, reaction });
    return true;
  } catch (error) {
    // Reaction may already exist or node doesn't support reactions
    logger.debug('[state-comment] Failed to add reaction to node', { nodeId, error });
    return false;
  }
}

/**
 * Helper: Register parent-child relationship in state
 */
export async function registerParentChild(
  owner: string,
  repo: string,
  pr: number,
  parentId: string,
  childIds: string[]
): Promise<void> {
  const state = await loadState(owner, repo, pr);

  if (state.parentChildren[parentId]) {
    // Already registered
    return;
  }

  state.parentChildren[parentId] = {
    childIds,
    childStatus: Object.fromEntries(childIds.map(id => [id, 'pending' as const])),
    registeredAt: new Date().toISOString()
  };

  await saveState(owner, repo, pr, state);
}

/**
 * Helper: Mark child as resolved and check if all siblings done
 */
export async function markChildResolved(
  owner: string,
  repo: string,
  pr: number,
  childId: string
): Promise<{ parentId: string; allResolved: boolean } | null> {
  const state = await loadState(owner, repo, pr);

  // Find parent for this child
  for (const [parentId, entry] of Object.entries(state.parentChildren)) {
    if (childId in entry.childStatus) {
      entry.childStatus[childId] = 'resolved';
      await saveState(owner, repo, pr, state);

      const allResolved = Object.values(entry.childStatus).every(s => s === 'resolved');
      return { parentId, allResolved };
    }
  }

  return null;
}

/**
 * Helper: Check if child is already resolved
 */
export async function isChildResolved(
  owner: string,
  repo: string,
  pr: number,
  childId: string
): Promise<boolean> {
  const state = await loadState(owner, repo, pr);

  for (const entry of Object.values(state.parentChildren)) {
    if (entry.childStatus[childId] === 'resolved') {
      return true;
    }
  }

  return false;
}

/**
 * Helper: Get parent ID for a child
 */
export async function getParentIdForChild(
  owner: string,
  repo: string,
  pr: number,
  childId: string
): Promise<string | null> {
  const state = await loadState(owner, repo, pr);

  for (const [parentId, entry] of Object.entries(state.parentChildren)) {
    if (childId in entry.childStatus) {
      return parentId;
    }
  }

  return null;
}

/**
 * Helper: Mark nitpick as resolved (for synthetic comments)
 */
export async function markNitpickResolved(
  owner: string,
  repo: string,
  pr: number,
  nitpickId: string,
  agentId: string
): Promise<void> {
  const state = await loadState(owner, repo, pr);

  state.resolvedNitpicks[nitpickId] = {
    resolvedAt: new Date().toISOString(),
    resolvedBy: agentId
  };

  await saveState(owner, repo, pr, state);
}

/**
 * Helper: Check if nitpick is resolved
 */
export async function isNitpickResolved(
  owner: string,
  repo: string,
  pr: number,
  nitpickId: string
): Promise<boolean> {
  const state = await loadState(owner, repo, pr);
  return nitpickId in state.resolvedNitpicks;
}
