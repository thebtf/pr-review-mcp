/**
 * Unit tests for the classify-unresolved classification helper.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyFinding,
  computeMergeReadiness,
  type FindingInput,
  type ClassifiedFinding,
} from './classify-unresolved.js';

// ============================================================================
// Test fixtures
// ============================================================================

function makeFinding(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    threadId: 'PRRT_thread_001',
    outdated: false,
    resolved: false,
    severity: 'MAJOR',
    source: 'coderabbit',
    ...overrides,
  };
}

// ============================================================================
// classifyFinding
// ============================================================================

describe('classifyFinding', () => {
  describe('synthetic findings', () => {
    it('classifies coderabbit-nitpick- prefixed thread as non_blocking_residual/synthetic', () => {
      const result = classifyFinding(makeFinding({ threadId: 'coderabbit-nitpick-abc123' }));
      expect(result.actionClass).toBe('non_blocking_residual');
      expect(result.blocksMerge).toBe(false);
      expect(result.residualKind).toBe('synthetic');
      expect(result.classificationReason).toBe('synthetic_adapter_comment');
    });

    it('classifies coderabbit-outside-diff- prefixed thread as non_blocking_residual/synthetic', () => {
      const result = classifyFinding(makeFinding({ threadId: 'coderabbit-outside-diff-xyz' }));
      expect(result.actionClass).toBe('non_blocking_residual');
      expect(result.blocksMerge).toBe(false);
      expect(result.residualKind).toBe('synthetic');
    });

    it('classifies source=coderabbit-nitpick as non_blocking_residual/synthetic', () => {
      const result = classifyFinding(makeFinding({ source: 'coderabbit-nitpick', threadId: 'PRRT_real_001' }));
      expect(result.actionClass).toBe('non_blocking_residual');
      expect(result.blocksMerge).toBe(false);
      expect(result.residualKind).toBe('synthetic');
    });

    it('synthetic classification takes precedence over outdated flag', () => {
      const result = classifyFinding(makeFinding({
        threadId: 'coderabbit-nitpick-stale',
        outdated: true,
      }));
      // Synthetic wins over stale
      expect(result.residualKind).toBe('synthetic');
    });
  });

  describe('stale findings', () => {
    it('classifies an outdated thread as non_blocking_residual/stale', () => {
      const result = classifyFinding(makeFinding({ outdated: true }));
      expect(result.actionClass).toBe('non_blocking_residual');
      expect(result.blocksMerge).toBe(false);
      expect(result.residualKind).toBe('stale');
      expect(result.classificationReason).toBe('outdated_thread');
    });

    it('a real thread that is not outdated is NOT classified as stale', () => {
      const result = classifyFinding(makeFinding({ outdated: false }));
      expect(result.residualKind).toBeUndefined();
    });
  });

  describe('fix_now findings', () => {
    const actionableSeverities = ['CRIT', 'MAJOR', 'MINOR', 'ISSUE', 'REFACTOR', 'NITPICK', 'TRIVIAL', 'DOCS'];

    for (const severity of actionableSeverities) {
      it(`classifies ${severity} finding on a valid thread as fix_now`, () => {
        const result = classifyFinding(makeFinding({ severity }));
        expect(result.actionClass).toBe('fix_now');
        expect(result.blocksMerge).toBe(true);
        expect(result.classificationReason).toBe('valid_unresolved_finding');
      });
    }
  });

  describe('needs_human_judgement (fail-closed) findings', () => {
    it('classifies N/A severity as needs_human_judgement', () => {
      const result = classifyFinding(makeFinding({ severity: 'N/A' }));
      expect(result.actionClass).toBe('needs_human_judgement');
      expect(result.blocksMerge).toBe(true);
    });

    it('classifies unrecognised severity as needs_human_judgement', () => {
      const result = classifyFinding(makeFinding({ severity: 'TOTALLY_UNKNOWN' }));
      expect(result.actionClass).toBe('needs_human_judgement');
      expect(result.blocksMerge).toBe(true);
      expect(result.classificationReason).toBe('unrecognised_or_missing_severity');
    });
  });
});

// ============================================================================
// computeMergeReadiness
// ============================================================================

describe('computeMergeReadiness', () => {
  function classified(actionClass: ClassifiedFinding['actionClass']): ClassifiedFinding {
    return {
      actionClass,
      blocksMerge: actionClass === 'fix_now' || actionClass === 'needs_human_judgement',
      classificationReason: 'test',
    };
  }

  describe('mergeReady: true cases', () => {
    it('is merge-ready when GitHub signals are green and no blocking findings remain', () => {
      const result = computeMergeReadiness({
        reviewDecision: 'APPROVED',
        mergeStateStatus: 'CLEAN',
        checksPass: true,
        classifiedFindings: [],
      });
      expect(result.mergeReady).toBe(true);
    });

    it('is merge-ready when only stale/synthetic residue remains and GitHub is green', () => {
      const result = computeMergeReadiness({
        reviewDecision: 'APPROVED',
        mergeStateStatus: 'CLEAN',
        classifiedFindings: [
          classified('non_blocking_residual'),
          classified('non_blocking_residual'),
        ],
      });
      expect(result.mergeReady).toBe(true);
      expect(result.notes).toContain('2 non-blocking residual finding(s) remain (stale or synthetic)');
    });

    it('treats null reviewDecision as not blocking merge', () => {
      const result = computeMergeReadiness({
        reviewDecision: null,
        mergeStateStatus: 'CLEAN',
        classifiedFindings: [],
      });
      expect(result.mergeReady).toBe(true);
    });

    it('treats absent merge status signals as not blocking merge', () => {
      const result = computeMergeReadiness({
        classifiedFindings: [],
      });
      expect(result.mergeReady).toBe(true);
    });
  });

  describe('mergeReady: false cases', () => {
    it('is NOT merge-ready when fix_now finding is present', () => {
      const result = computeMergeReadiness({
        reviewDecision: 'APPROVED',
        mergeStateStatus: 'CLEAN',
        classifiedFindings: [classified('fix_now')],
      });
      expect(result.mergeReady).toBe(false);
      expect(result.notes).toContain('1 finding(s) require immediate action before merge');
    });

    it('is NOT merge-ready when needs_human_judgement finding is present', () => {
      const result = computeMergeReadiness({
        reviewDecision: 'APPROVED',
        mergeStateStatus: 'CLEAN',
        classifiedFindings: [classified('needs_human_judgement')],
      });
      expect(result.mergeReady).toBe(false);
      expect(result.notes).toContain('1 finding(s) require human judgement');
    });

    it('is NOT merge-ready when reviewDecision is CHANGES_REQUESTED', () => {
      const result = computeMergeReadiness({
        reviewDecision: 'CHANGES_REQUESTED',
        mergeStateStatus: 'CLEAN',
        classifiedFindings: [],
      });
      expect(result.mergeReady).toBe(false);
      expect(result.notes).toContain('GitHub review decision: CHANGES_REQUESTED');
    });

    it('is NOT merge-ready when mergeStateStatus is BLOCKED', () => {
      const result = computeMergeReadiness({
        reviewDecision: 'APPROVED',
        mergeStateStatus: 'BLOCKED',
        classifiedFindings: [],
      });
      expect(result.mergeReady).toBe(false);
      expect(result.notes).toContain('GitHub merge state: BLOCKED');
    });

    it('is NOT merge-ready when checksPass is false', () => {
      const result = computeMergeReadiness({
        reviewDecision: 'APPROVED',
        mergeStateStatus: 'CLEAN',
        checksPass: false,
        classifiedFindings: [],
      });
      expect(result.mergeReady).toBe(false);
      expect(result.notes).toContain('Required CI checks have not passed');
    });
  });

  describe('reviewReady', () => {
    it('is review-ready when allAgentsReady is true', () => {
      const result = computeMergeReadiness({
        classifiedFindings: [],
        allAgentsReady: true,
      });
      expect(result.reviewReady).toBe(true);
    });

    it('is review-ready when allAgentsReady is not provided', () => {
      const result = computeMergeReadiness({
        classifiedFindings: [],
      });
      expect(result.reviewReady).toBe(true);
    });

    it('is NOT review-ready when allAgentsReady is false', () => {
      const result = computeMergeReadiness({
        classifiedFindings: [],
        allAgentsReady: false,
      });
      expect(result.reviewReady).toBe(false);
      expect(result.notes).toContain('Not all review agents have completed');
    });
  });

  describe('unresolvedByClass counts', () => {
    it('counts each class correctly', () => {
      const result = computeMergeReadiness({
        classifiedFindings: [
          classified('fix_now'),
          classified('fix_now'),
          classified('non_blocking_residual'),
          classified('systemic_follow_up'),
          classified('needs_human_judgement'),
        ],
      });
      expect(result.unresolvedByClass.fix_now).toBe(2);
      expect(result.unresolvedByClass.non_blocking_residual).toBe(1);
      expect(result.unresolvedByClass.systemic_follow_up).toBe(1);
      expect(result.unresolvedByClass.needs_human_judgement).toBe(1);
    });

    it('returns zero counts when no findings are present', () => {
      const result = computeMergeReadiness({ classifiedFindings: [] });
      expect(result.unresolvedByClass.fix_now).toBe(0);
      expect(result.unresolvedByClass.non_blocking_residual).toBe(0);
      expect(result.unresolvedByClass.systemic_follow_up).toBe(0);
      expect(result.unresolvedByClass.needs_human_judgement).toBe(0);
    });
  });

  describe('notes for systemic follow-up', () => {
    it('includes a note when systemic_follow_up findings exist', () => {
      const result = computeMergeReadiness({
        classifiedFindings: [classified('systemic_follow_up')],
      });
      expect(result.notes).toContain('1 systemic finding(s) flagged for follow-up');
    });
  });
});
