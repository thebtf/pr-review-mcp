/**
 * Classification helper for PR review findings.
 *
 * Assigns each unresolved finding an action class that determines whether it
 * blocks merge, so consumers can make correct merge decisions without
 * re-deriving policy from raw unresolved counts.
 */

// ============================================================================
// Types
// ============================================================================

export type ActionClass =
  | 'fix_now'
  | 'non_blocking_residual'
  | 'systemic_follow_up'
  | 'needs_human_judgement';

export type ResidualKind = 'stale' | 'synthetic';

export interface ClassifiedFinding {
  actionClass: ActionClass;
  blocksMerge: boolean;
  classificationReason: string;
  residualKind?: ResidualKind;
}

export interface FindingInput {
  /** Provider-assigned thread/comment identifier */
  threadId: string;
  /** Whether the thread is marked outdated by GitHub */
  outdated: boolean;
  /** Whether the thread is resolved */
  resolved: boolean;
  /** Severity label extracted from the comment body */
  severity: string;
  /** Adapter source identifier */
  source: string;
}

export interface MergeStatusInput {
  /** GitHub reviewDecision: APPROVED | REVIEW_REQUIRED | CHANGES_REQUESTED | null */
  reviewDecision?: string | null;
  /** GitHub mergeStateStatus: CLEAN | BLOCKED | BEHIND | UNSTABLE | HAS_HOOKS | UNKNOWN */
  mergeStateStatus?: string | null;
  /** Whether required CI checks have passed */
  checksPass?: boolean | null;
  /** All unresolved findings after classification */
  classifiedFindings: ClassifiedFinding[];
  /** Whether all expected agents have completed their reviews */
  allAgentsReady?: boolean;
}

export interface MergeReadiness {
  mergeReady: boolean;
  reviewReady: boolean;
  notes: string[];
  unresolvedByClass: Record<ActionClass, number>;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Synthetic findings are adapter-generated — their identity or provenance is
 * produced by an adapter layer rather than a first-class GitHub review thread.
 * The source prefix is the authoritative signal.
 */
function isSynthetic(finding: FindingInput): boolean {
  return (
    finding.threadId.startsWith('coderabbit-nitpick-') ||
    finding.threadId.startsWith('coderabbit-outside-diff-') ||
    finding.source === 'coderabbit-nitpick'
  );
}

/**
 * Stale findings come from real provider threads whose underlying code no
 * longer triggers the concern (GitHub marks the thread outdated).
 */
function isStale(finding: FindingInput): boolean {
  return finding.outdated === true;
}

// ============================================================================
// Classification
// ============================================================================

/**
 * Classify a single unresolved finding into an action class.
 *
 * Decision ladder (first match wins):
 * 1. Synthetic adapter-generated comment → non_blocking_residual / synthetic
 * 2. Outdated thread → non_blocking_residual / stale
 * 3. Valid finding with a recognised severity → fix_now (blocks merge)
 * 4. Valid finding with unrecognised severity → needs_human_judgement (fail closed)
 */
export function classifyFinding(finding: FindingInput): ClassifiedFinding {
  if (isSynthetic(finding)) {
    return {
      actionClass: 'non_blocking_residual',
      blocksMerge: false,
      classificationReason: 'synthetic_adapter_comment',
      residualKind: 'synthetic',
    };
  }

  if (isStale(finding)) {
    return {
      actionClass: 'non_blocking_residual',
      blocksMerge: false,
      classificationReason: 'outdated_thread',
      residualKind: 'stale',
    };
  }

  // Valid first-class provider thread — any recognised severity is actionable.
  // N/A severity on an unresolved thread is ambiguous: fail closed.
  const knownSeverities = new Set([
    'CRIT', 'MAJOR', 'MINOR', 'ISSUE', 'REFACTOR', 'NITPICK', 'TRIVIAL', 'DOCS',
  ]);

  if (finding.severity === 'N/A' || !knownSeverities.has(finding.severity)) {
    return {
      actionClass: 'needs_human_judgement',
      blocksMerge: true,
      classificationReason: 'unrecognised_or_missing_severity',
    };
  }

  return {
    actionClass: 'fix_now',
    blocksMerge: true,
    classificationReason: 'valid_unresolved_finding',
  };
}

/**
 * Compute merge readiness from GitHub signals and classified findings.
 *
 * mergeReady requires ALL of:
 *  - GitHub reviewDecision is APPROVED (or not provided)
 *  - GitHub mergeStateStatus is CLEAN (or not provided)
 *  - No fix_now or needs_human_judgement findings remain
 *
 * reviewReady is true when allAgentsReady is true (or not provided).
 *
 * Notes describe any non-blocking residue that remains so callers have
 * full diagnostic context.
 */
export function computeMergeReadiness(input: MergeStatusInput): MergeReadiness {
  const { reviewDecision, mergeStateStatus, checksPass, classifiedFindings, allAgentsReady } = input;

  const counts: Record<ActionClass, number> = {
    fix_now: 0,
    non_blocking_residual: 0,
    systemic_follow_up: 0,
    needs_human_judgement: 0,
  };

  for (const f of classifiedFindings) {
    counts[f.actionClass]++;
  }

  const hasBlockingFindings = counts.fix_now > 0 || counts.needs_human_judgement > 0;

  const githubApproved =
    reviewDecision == null || reviewDecision === 'APPROVED';

  const githubClean =
    mergeStateStatus == null || mergeStateStatus === 'CLEAN';

  const checksOk = checksPass == null || checksPass === true;

  const mergeReady = githubApproved && githubClean && checksOk && !hasBlockingFindings;

  const reviewReady = allAgentsReady == null || allAgentsReady === true;

  const notes: string[] = [];

  if (!githubApproved && reviewDecision != null) {
    notes.push(`GitHub review decision: ${reviewDecision}`);
  }

  if (!githubClean && mergeStateStatus != null) {
    notes.push(`GitHub merge state: ${mergeStateStatus}`);
  }

  if (checksPass === false) {
    notes.push('Required CI checks have not passed');
  }

  if (counts.fix_now > 0) {
    notes.push(`${counts.fix_now} finding(s) require immediate action before merge`);
  }

  if (counts.needs_human_judgement > 0) {
    notes.push(`${counts.needs_human_judgement} finding(s) require human judgement`);
  }

  if (counts.non_blocking_residual > 0) {
    notes.push(`${counts.non_blocking_residual} non-blocking residual finding(s) remain (stale or synthetic)`);
  }

  if (counts.systemic_follow_up > 0) {
    notes.push(`${counts.systemic_follow_up} systemic finding(s) flagged for follow-up`);
  }

  if (!reviewReady) {
    notes.push('Not all review agents have completed');
  }

  return {
    mergeReady,
    reviewReady,
    notes,
    unresolvedByClass: counts,
  };
}
