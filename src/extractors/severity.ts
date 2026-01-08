/**
 * Severity Extraction
 * Supports multiple sources: CodeRabbit, Gemini Code Assist, Codex
 */

export type Severity = 'CRIT' | 'MAJOR' | 'MINOR' | 'TRIVIAL' | 'ISSUE' | 'REFACTOR' | 'NITPICK' | 'DOCS' | 'N/A';
export type IssueType = 'issue' | 'refactor' | 'nitpick' | 'docs' | 'other';
export type CommentSource = 'coderabbit' | 'gemini' | 'codex' | 'unknown';

export interface SeverityResult {
  severity: Severity;
  type: IssueType;
  source: CommentSource;
}

interface SeverityPattern {
  pattern: RegExp;
  severity: Severity;
  source: CommentSource;
}

// ============================================================================
// Severity Patterns by Source
// ============================================================================

const SEVERITY_PATTERNS: SeverityPattern[] = [
  // CodeRabbit patterns (emoji-based)
  { pattern: /🔴\s*Critical/i, severity: 'CRIT', source: 'coderabbit' },
  { pattern: /🟠\s*Major/i, severity: 'MAJOR', source: 'coderabbit' },
  { pattern: /🟡\s*Minor/i, severity: 'MINOR', source: 'coderabbit' },
  { pattern: /🔵\s*Trivial/i, severity: 'TRIVIAL', source: 'coderabbit' },
  { pattern: /⚠️\s*(?:Potential\s+)?issue/i, severity: 'ISSUE', source: 'coderabbit' },
  { pattern: /🛠️\s*Refactor/i, severity: 'REFACTOR', source: 'coderabbit' },
  { pattern: /🧹\s*Nitpick/i, severity: 'NITPICK', source: 'coderabbit' },
  { pattern: /📝\s*Documentation/i, severity: 'DOCS', source: 'coderabbit' },

  // Gemini Code Assist patterns (image badges)
  { pattern: /!\[critical\]\(https:\/\/www\.gstatic\.com\/codereviewagent\/critical\.svg\)/i, severity: 'CRIT', source: 'gemini' },
  { pattern: /!\[high\]\(https:\/\/www\.gstatic\.com\/codereviewagent\/high\.svg\)/i, severity: 'MAJOR', source: 'gemini' },
  { pattern: /!\[medium\]\(https:\/\/www\.gstatic\.com\/codereviewagent\/medium\.svg\)/i, severity: 'MINOR', source: 'gemini' },
  { pattern: /!\[low\]\(https:\/\/www\.gstatic\.com\/codereviewagent\/low\.svg\)/i, severity: 'TRIVIAL', source: 'gemini' },

  // Codex patterns (shields.io badges with P0/P1/P2 priority)
  { pattern: /!\[P0\s*Badge\]\(https:\/\/img\.shields\.io\/badge\/P0/i, severity: 'CRIT', source: 'codex' },
  { pattern: /!\[P1\s*Badge\]\(https:\/\/img\.shields\.io\/badge\/P1/i, severity: 'MAJOR', source: 'codex' },
  { pattern: /!\[P2\s*Badge\]\(https:\/\/img\.shields\.io\/badge\/P2/i, severity: 'MINOR', source: 'codex' },
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
 * Detect comment source from body
 */
export function detectSource(body: string | null | undefined): CommentSource {
  if (!body) return 'unknown';

  // CodeRabbit markers
  if (body.includes('CodeRabbit') || body.includes('🤖 Prompt for AI Agents') || body.includes('🧩 Analysis chain')) {
    return 'coderabbit';
  }

  // Gemini Code Assist markers
  if (body.includes('gstatic.com/codereviewagent/') || body.includes('gemini-code-assist')) {
    return 'gemini';
  }

  // Codex markers (shields.io badges + feedback prompt)
  if (body.includes('img.shields.io/badge/P') || body.includes('Useful? React with')) {
    return 'codex';
  }

  return 'unknown';
}

/**
 * Extract severity from comment body
 */
export function extractSeverity(body: string | null | undefined): SeverityResult {
  if (!body) {
    return { severity: 'N/A', type: 'other', source: 'unknown' };
  }

  for (const { pattern, severity, source } of SEVERITY_PATTERNS) {
    if (pattern.test(body)) {
      // Map to type
      let type: IssueType = 'other';
      if (['CRIT', 'MAJOR', 'MINOR'].includes(severity)) type = 'issue';
      else if (severity === 'REFACTOR') type = 'refactor';
      else if (severity === 'NITPICK' || severity === 'TRIVIAL') type = 'nitpick';
      else if (severity === 'DOCS') type = 'docs';
      else if (severity === 'ISSUE') type = 'issue';

      return { severity, type, source };
    }
  }

  // No severity pattern matched, try to detect source anyway
  const source = detectSource(body);
  return { severity: 'N/A', type: 'other', source };
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
