/**
 * Unit tests for severity extraction
 */

import { describe, it, expect } from 'vitest';
import {
  detectSource,
  extractSeverity,
  detectCopilotSeverity,
  isResolvedByMarker,
  SEVERITY_ORDER,
  SEVERITY_ICONS,
  type Severity,
  type CommentSource,
} from './severity.js';

describe('detectSource', () => {
  describe('author-based detection', () => {
    it('detects Copilot from author', () => {
      expect(detectSource('some body', 'copilot-pull-request-reviewer')).toBe('copilot');
      expect(detectSource('some body', 'github-copilot')).toBe('copilot');
    });

    it('detects Sourcery from author', () => {
      expect(detectSource('some body', 'sourcery-ai')).toBe('sourcery');
      expect(detectSource('some body', 'sourcery-ai-experiments')).toBe('sourcery');
    });
  });

  describe('content-based detection', () => {
    it('detects CodeRabbit from markers', () => {
      expect(detectSource('Review by CodeRabbit')).toBe('coderabbit');
      expect(detectSource('🤖 Prompt for AI Agents')).toBe('coderabbit');
      expect(detectSource('🧩 Analysis chain')).toBe('coderabbit');
    });

    it('detects Gemini from gstatic URLs', () => {
      expect(detectSource('![critical](https://www.gstatic.com/codereviewagent/critical.svg)')).toBe('gemini');
      expect(detectSource('gemini-code-assist review')).toBe('gemini');
    });

    it('detects Codex from shields.io badges', () => {
      expect(detectSource('![P0 Badge](https://img.shields.io/badge/P0-critical-red)')).toBe('codex');
      expect(detectSource('Useful? React with 👍 or 👎')).toBe('codex');
    });

    it('returns unknown for unrecognized content', () => {
      expect(detectSource('Just a regular comment')).toBe('unknown');
    });
  });

  describe('edge cases', () => {
    it('handles null and undefined', () => {
      expect(detectSource(null)).toBe('unknown');
      expect(detectSource(undefined)).toBe('unknown');
    });

    it('handles empty string', () => {
      expect(detectSource('')).toBe('unknown');
    });
  });
});

describe('extractSeverity', () => {
  describe('CodeRabbit patterns', () => {
    it('extracts CRIT from red circle', () => {
      const result = extractSeverity('🔴 Critical issue found');
      expect(result.severity).toBe('CRIT');
      expect(result.source).toBe('coderabbit');
      expect(result.type).toBe('issue');
    });

    it('extracts MAJOR from orange circle', () => {
      const result = extractSeverity('🟠 Major problem');
      expect(result.severity).toBe('MAJOR');
      expect(result.source).toBe('coderabbit');
    });

    it('extracts MINOR from yellow circle', () => {
      const result = extractSeverity('🟡 Minor suggestion');
      expect(result.severity).toBe('MINOR');
      expect(result.source).toBe('coderabbit');
    });

    it('extracts TRIVIAL from blue circle', () => {
      const result = extractSeverity('🔵 Trivial fix');
      expect(result.severity).toBe('TRIVIAL');
      expect(result.source).toBe('coderabbit');
      expect(result.type).toBe('nitpick');
    });

    it('extracts ISSUE from warning emoji', () => {
      const result = extractSeverity('⚠️ issue: check this');
      expect(result.severity).toBe('ISSUE');
      expect(result.source).toBe('coderabbit');
    });

    it('extracts ISSUE from potential issue', () => {
      const result = extractSeverity('⚠️ Potential issue with null');
      expect(result.severity).toBe('ISSUE');
      expect(result.source).toBe('coderabbit');
    });

    it('extracts REFACTOR from hammer emoji', () => {
      const result = extractSeverity('🛠️ Refactor this function');
      expect(result.severity).toBe('REFACTOR');
      expect(result.source).toBe('coderabbit');
      expect(result.type).toBe('refactor');
    });

    it('extracts NITPICK from broom emoji', () => {
      const result = extractSeverity('🧹 Nitpick: extra whitespace');
      expect(result.severity).toBe('NITPICK');
      expect(result.source).toBe('coderabbit');
      expect(result.type).toBe('nitpick');
    });

    it('extracts DOCS from memo emoji', () => {
      const result = extractSeverity('📝 Documentation needed');
      expect(result.severity).toBe('DOCS');
      expect(result.source).toBe('coderabbit');
      expect(result.type).toBe('docs');
    });
  });

  describe('Gemini patterns', () => {
    it('extracts CRIT from critical badge', () => {
      const result = extractSeverity('![critical](https://www.gstatic.com/codereviewagent/critical.svg) Security issue');
      expect(result.severity).toBe('CRIT');
      expect(result.source).toBe('gemini');
    });

    it('extracts MAJOR from high badge', () => {
      const result = extractSeverity('![high](https://www.gstatic.com/codereviewagent/high.svg) Bug found');
      expect(result.severity).toBe('MAJOR');
      expect(result.source).toBe('gemini');
    });

    it('extracts MINOR from medium badge', () => {
      const result = extractSeverity('![medium](https://www.gstatic.com/codereviewagent/medium.svg) Suggestion');
      expect(result.severity).toBe('MINOR');
      expect(result.source).toBe('gemini');
    });

    it('extracts TRIVIAL from low badge', () => {
      const result = extractSeverity('![low](https://www.gstatic.com/codereviewagent/low.svg) Style');
      expect(result.severity).toBe('TRIVIAL');
      expect(result.source).toBe('gemini');
    });
  });

  describe('Codex patterns', () => {
    it('extracts CRIT from P0 badge', () => {
      const result = extractSeverity('![P0 Badge](https://img.shields.io/badge/P0-critical-red)');
      expect(result.severity).toBe('CRIT');
      expect(result.source).toBe('codex');
    });

    it('extracts MAJOR from P1 badge', () => {
      const result = extractSeverity('![P1 Badge](https://img.shields.io/badge/P1-major-orange)');
      expect(result.severity).toBe('MAJOR');
      expect(result.source).toBe('codex');
    });

    it('extracts MINOR from P2 badge', () => {
      const result = extractSeverity('![P2 Badge](https://img.shields.io/badge/P2-minor-yellow)');
      expect(result.severity).toBe('MINOR');
      expect(result.source).toBe('codex');
    });
  });

  describe('Sourcery patterns', () => {
    it('extracts CRIT from security issue', () => {
      const result = extractSeverity('**issue (security):** SQL injection vulnerability');
      expect(result.severity).toBe('CRIT');
      expect(result.source).toBe('sourcery');
    });

    it('extracts MAJOR from bug_risk issue', () => {
      const result = extractSeverity('**issue (bug_risk):** Null pointer dereference');
      expect(result.severity).toBe('MAJOR');
      expect(result.source).toBe('sourcery');
    });

    it('extracts ISSUE from generic issue', () => {
      const result = extractSeverity('**issue (performance):** Slow loop');
      expect(result.severity).toBe('ISSUE');
      expect(result.source).toBe('sourcery');
    });

    it('extracts MINOR from suggestion', () => {
      const result = extractSeverity('**suggestion (style):** Consider renaming');
      expect(result.severity).toBe('MINOR');
      expect(result.source).toBe('sourcery');
    });
  });

  describe('Copilot detection', () => {
    it('uses heuristic detection for Copilot author', () => {
      const result = extractSeverity('This code has a security vulnerability', 'copilot-pull-request-reviewer');
      expect(result.severity).toBe('CRIT');
      expect(result.source).toBe('copilot');
    });

    it('detects major issues for Copilot', () => {
      const result = extractSeverity('There is a bug in this function', 'copilot-pull-request-reviewer');
      expect(result.severity).toBe('MAJOR');
      expect(result.source).toBe('copilot');
    });

    it('detects minor issues for Copilot', () => {
      const result = extractSeverity('Consider using a more descriptive name', 'copilot-pull-request-reviewer');
      expect(result.severity).toBe('MINOR');
      expect(result.source).toBe('copilot');
    });
  });

  describe('edge cases', () => {
    it('returns N/A for null body', () => {
      const result = extractSeverity(null);
      expect(result.severity).toBe('N/A');
      expect(result.type).toBe('other');
      expect(result.source).toBe('unknown');
    });

    it('returns N/A for undefined body', () => {
      const result = extractSeverity(undefined);
      expect(result.severity).toBe('N/A');
    });

    it('returns N/A for body without severity markers', () => {
      const result = extractSeverity('Just a regular comment without any markers');
      expect(result.severity).toBe('N/A');
    });

    it('is case insensitive for patterns', () => {
      expect(extractSeverity('🔴 CRITICAL').severity).toBe('CRIT');
      expect(extractSeverity('🔴 critical').severity).toBe('CRIT');
      expect(extractSeverity('🔴 CrItIcAl').severity).toBe('CRIT');
    });
  });
});

describe('detectCopilotSeverity', () => {
  describe('critical indicators', () => {
    it('detects security keywords', () => {
      expect(detectCopilotSeverity('This has a security flaw')).toBe('CRIT');
    });

    it('detects vulnerability keywords', () => {
      expect(detectCopilotSeverity('Potential vulnerability here')).toBe('CRIT');
    });

    it('detects critical keywords', () => {
      expect(detectCopilotSeverity('Critical error in logic')).toBe('CRIT');
    });

    it('detects dangerous keywords', () => {
      expect(detectCopilotSeverity('This is dangerous code')).toBe('CRIT');
    });
  });

  describe('major indicators', () => {
    it('detects bug keywords', () => {
      expect(detectCopilotSeverity('There is a bug here')).toBe('MAJOR');
    });

    it('detects error keywords', () => {
      expect(detectCopilotSeverity('This will cause an error')).toBe('MAJOR');
    });

    it('detects incorrect keywords', () => {
      expect(detectCopilotSeverity('The logic is incorrect')).toBe('MAJOR');
    });

    it('detects wrong keywords', () => {
      expect(detectCopilotSeverity('This is wrong')).toBe('MAJOR');
    });

    it('detects broken keywords', () => {
      expect(detectCopilotSeverity('This code is broken')).toBe('MAJOR');
    });

    it('detects unused keywords', () => {
      expect(detectCopilotSeverity('Unused variable here')).toBe('MAJOR');
    });
  });

  describe('minor indicators', () => {
    it('detects consider keywords', () => {
      expect(detectCopilotSeverity('Consider using const')).toBe('MINOR');
    });

    it('detects should keywords', () => {
      expect(detectCopilotSeverity('You should rename this')).toBe('MINOR');
    });

    it('detects could keywords', () => {
      expect(detectCopilotSeverity('This could be simplified')).toBe('MINOR');
    });

    it('detects suggestion keywords', () => {
      expect(detectCopilotSeverity('Suggestion: use a map')).toBe('MINOR');
    });

    it('detects redundant keywords', () => {
      expect(detectCopilotSeverity('This code is redundant')).toBe('MINOR');
    });

    it('detects simplif* keywords', () => {
      expect(detectCopilotSeverity('This can be simplified')).toBe('MINOR');
      expect(detectCopilotSeverity('Simplify this logic')).toBe('MINOR');
    });
  });

  describe('no severity', () => {
    it('returns N/A for generic comments', () => {
      expect(detectCopilotSeverity('Nice work!')).toBe('N/A');
      expect(detectCopilotSeverity('Looks good to me')).toBe('N/A');
    });
  });

  describe('case insensitivity', () => {
    it('is case insensitive', () => {
      expect(detectCopilotSeverity('SECURITY issue')).toBe('CRIT');
      expect(detectCopilotSeverity('BUG found')).toBe('MAJOR');
      expect(detectCopilotSeverity('CONSIDER this')).toBe('MINOR');
    });
  });
});

describe('isResolvedByMarker', () => {
  it('detects Addressed marker', () => {
    expect(isResolvedByMarker('✅ Addressed')).toBe(true);
    expect(isResolvedByMarker('Comment\n✅ Addressed\nMore text')).toBe(true);
  });

  it('detects Resolved marker', () => {
    expect(isResolvedByMarker('✅ Resolved')).toBe(true);
  });

  it('detects [Resolved] marker', () => {
    expect(isResolvedByMarker('[Resolved]')).toBe(true);
  });

  it('returns false without markers', () => {
    expect(isResolvedByMarker('Just a comment')).toBe(false);
  });

  it('handles null and undefined', () => {
    expect(isResolvedByMarker(null)).toBe(false);
    expect(isResolvedByMarker(undefined)).toBe(false);
  });
});

describe('constants', () => {
  describe('SEVERITY_ORDER', () => {
    it('has correct order from most to least severe', () => {
      expect(SEVERITY_ORDER[0]).toBe('CRIT');
      expect(SEVERITY_ORDER[SEVERITY_ORDER.length - 1]).toBe('N/A');
    });

    it('contains all severity levels', () => {
      const expected: Severity[] = ['CRIT', 'MAJOR', 'MINOR', 'ISSUE', 'REFACTOR', 'NITPICK', 'TRIVIAL', 'DOCS', 'N/A'];
      expect(SEVERITY_ORDER).toEqual(expected);
    });
  });

  describe('SEVERITY_ICONS', () => {
    it('has icons for all severity levels', () => {
      const severities: Severity[] = ['CRIT', 'MAJOR', 'MINOR', 'ISSUE', 'REFACTOR', 'NITPICK', 'TRIVIAL', 'DOCS', 'N/A'];
      for (const sev of severities) {
        expect(SEVERITY_ICONS[sev]).toBeDefined();
      }
    });

    it('has correct icons', () => {
      expect(SEVERITY_ICONS['CRIT']).toBe('🔴');
      expect(SEVERITY_ICONS['MAJOR']).toBe('🟠');
      expect(SEVERITY_ICONS['MINOR']).toBe('🟡');
      expect(SEVERITY_ICONS['N/A']).toBe('⚪');
    });
  });
});
