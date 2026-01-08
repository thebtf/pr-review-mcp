/**
 * Severity Extraction
 * Ported from coderabbit-processor.js lib/prompt-extractor.js
 */

export type Severity = 'CRIT' | 'MAJOR' | 'MINOR' | 'TRIVIAL' | 'ISSUE' | 'REFACTOR' | 'NITPICK' | 'DOCS' | 'N/A';
export type IssueType = 'issue' | 'refactor' | 'nitpick' | 'docs' | 'other';

export interface SeverityResult {
  severity: Severity;
  type: IssueType;
}

interface SeverityPattern {
  pattern: RegExp;
  severity: Severity;
}

// ============================================================================
// Severity Patterns
// ============================================================================

const SEVERITY_PATTERNS: SeverityPattern[] = [
  { pattern: /🔴\s*Critical/i, severity: 'CRIT' },
  { pattern: /🟠\s*Major/i, severity: 'MAJOR' },
  { pattern: /🟡\s*Minor/i, severity: 'MINOR' },
  { pattern: /🔵\s*Trivial/i, severity: 'TRIVIAL' },
  { pattern: /⚠️\s*(?:Potential\s+)?issue/i, severity: 'ISSUE' },
  { pattern: /🛠️\s*Refactor/i, severity: 'REFACTOR' },
  { pattern: /🧹\s*Nitpick/i, severity: 'NITPICK' },
  { pattern: /📝\s*Documentation/i, severity: 'DOCS' }
];

export const SEVERITY_ORDER: Severity[] = [
  'CRIT', 'MAJOR', 'MINOR', 'ISSUE', 'REFACTOR', 'NITPICK', 'TRIVIAL', 'DOCS', 'N/A'
];

export const SEVERITY_ICONS: Record<Severity, string> = {
  'CRIT': '🔴',
  'MAJOR': '🟠',
  'MINOR': '🟡',
  'ISSUE': '⚠️',
  'REFACTOR': '🛠️',
  'NITPICK': '🧹',
  'TRIVIAL': '🔵',
  'DOCS': '📝',
  'N/A': '⚪'
};

// ============================================================================
// Main Extraction Function
// ============================================================================

/**
 * Extract severity from comment body
 */
export function extractSeverity(body: string | null | undefined): SeverityResult {
  if (!body) {
    return { severity: 'N/A', type: 'other' };
  }

  for (const { pattern, severity } of SEVERITY_PATTERNS) {
    if (pattern.test(body)) {
      // Map to type
      let type: IssueType = 'other';
      if (['CRIT', 'MAJOR', 'MINOR'].includes(severity)) type = 'issue';
      else if (severity === 'REFACTOR') type = 'refactor';
      else if (severity === 'NITPICK' || severity === 'TRIVIAL') type = 'nitpick';
      else if (severity === 'DOCS') type = 'docs';
      else if (severity === 'ISSUE') type = 'issue';

      return { severity, type };
    }
  }

  return { severity: 'N/A', type: 'other' };
}

/**
 * Check if comment is resolved based on body markers
 */
export function isResolvedByMarker(body: string | null | undefined): boolean {
  if (!body) return false;

  return (
    body.includes('✅ Addressed') ||
    body.includes('✅ Resolved') ||
    body.includes('[Resolved]')
  );
}
