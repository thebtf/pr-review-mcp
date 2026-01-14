/**
 * Unit tests for AI prompt extraction
 */

import { describe, it, expect } from 'vitest';
import {
  extractPrompt,
  extractGeminiPrompt,
  extractCopilotPrompt,
  extractCodexPrompt,
  cleanPrompt,
  extractTitle,
  truncateBody,
} from './prompt.js';

describe('extractPrompt', () => {
  describe('explicit AI markers (Layer 1)', () => {
    it('extracts from HTML comment markers', () => {
      const body = `Some intro text
<!-- ai-prompt -->
Fix the null check on line 42
<!-- /ai-prompt -->
More text`;
      
      const result = extractPrompt(body);
      expect(result.confidence).toBe('high');
      expect(result.pattern).toBe('explicit_marker');
      expect(result.prompt).toContain('Fix the null check');
    });

    it('handles ai_prompt variant', () => {
      const body = `<!-- ai_prompt -->
Refactor this function
<!-- /ai_prompt -->`;
      
      const result = extractPrompt(body);
      expect(result.confidence).toBe('high');
      expect(result.prompt).toContain('Refactor');
    });
  });

  describe('CodeRabbit details block (Layer 2)', () => {
    it('extracts from 🤖 Prompt details block', () => {
      const body = `Some comment
<details>
<summary>🤖 Prompt for AI Agents</summary>

\`\`\`
Fix the authentication bug in login.ts
\`\`\`
</details>`;
      
      const result = extractPrompt(body, 'coderabbit');
      expect(result.confidence).toBe('high');
      expect(result.pattern).toBe('coderabbit_details_prompt');
      expect(result.prompt).toContain('authentication bug');
    });

    it('extracts from standalone 🤖 header', () => {
      const body = `🤖 Prompt for AI Agents
\`\`\`
Add error handling here
\`\`\``;
      
      const result = extractPrompt(body, 'coderabbit');
      expect(result.confidence).toBe('high');
      expect(result.prompt).toContain('error handling');
    });
  });

  describe('suggestion blocks (Layer 3)', () => {
    it('extracts from suggestion code blocks', () => {
      const body = `Consider this change:
\`\`\`suggestion
const value = data ?? defaultValue;
\`\`\``;
      
      const result = extractPrompt(body);
      expect(result.confidence).toBe('low');
      expect(result.pattern).toBe('suggestion_block');
      expect(result.prompt).toContain('const value');
    });

    it('extracts from diff code blocks', () => {
      const body = `Apply this diff:
\`\`\`diff
- const old = value;
+ const new = value;
\`\`\``;
      
      const result = extractPrompt(body);
      expect(result.confidence).toBe('low');
      expect(result.pattern).toBe('diff_block');
    });
  });

  describe('actionable text heuristic (Layer 4)', () => {
    it('extracts Consider statements', () => {
      const body = 'Consider using a more descriptive name for this variable.';
      const result = extractPrompt(body);
      expect(result.confidence).toBe('low');
      expect(result.pattern).toBe('actionable_heuristic');
    });

    it('extracts Should statements', () => {
      const body = 'Should add null check before dereferencing.';
      const result = extractPrompt(body);
      expect(result.confidence).toBe('low');
    });

    it('extracts Replace statements', () => {
      const body = 'Replace this deprecated method with the new API.';
      const result = extractPrompt(body);
      expect(result.confidence).toBe('low');
    });

    it('extracts Fix statements', () => {
      const body = 'Fix the race condition in this async code.';
      const result = extractPrompt(body);
      expect(result.confidence).toBe('low');
    });
  });

  describe('edge cases', () => {
    it('returns absent for null body', () => {
      const result = extractPrompt(null);
      expect(result.prompt).toBeNull();
      expect(result.confidence).toBe('absent');
      expect(result.pattern).toBeNull();
    });

    it('returns absent for undefined body', () => {
      const result = extractPrompt(undefined);
      expect(result.confidence).toBe('absent');
    });

    it('returns absent for short/empty prompt', () => {
      const body = 'OK';
      const result = extractPrompt(body);
      expect(result.confidence).toBe('absent');
    });
  });
});

describe('extractGeminiPrompt', () => {
  it('removes severity badge and returns description', () => {
    const body = '![high](https://www.gstatic.com/codereviewagent/high.svg) This variable should be const instead of let.';
    const result = extractGeminiPrompt(body);
    expect(result.prompt).toBe('This variable should be const instead of let.');
    expect(result.confidence).toBe('low');
    expect(result.pattern).toBe('gemini_description');
  });

  it('handles multiple badges', () => {
    const body = '![medium](https://www.gstatic.com/codereviewagent/medium.svg) Consider refactoring this function.';
    const result = extractGeminiPrompt(body);
    expect(result.prompt).not.toContain('gstatic');
  });

  it('returns absent for short content', () => {
    const body = '![low](https://www.gstatic.com/codereviewagent/low.svg) OK';
    const result = extractGeminiPrompt(body);
    expect(result.confidence).toBe('absent');
  });
});

describe('extractCopilotPrompt', () => {
  it('extracts suggestion block with description', () => {
    const body = `This could be simplified using optional chaining.

\`\`\`suggestion
const value = obj?.prop ?? default;
\`\`\``;
    
    const result = extractCopilotPrompt(body);
    expect(result.confidence).toBe('high');
    expect(result.pattern).toBe('copilot_suggestion');
    expect(result.prompt).toContain('optional chaining');
    expect(result.prompt).toContain('const value');
  });

  it('extracts suggestion block without description', () => {
    const body = `\`\`\`suggestion
const value = obj?.prop;
\`\`\``;
    
    const result = extractCopilotPrompt(body);
    expect(result.confidence).toBe('high');
    expect(result.prompt).toContain('const value');
  });

  it('falls back to description when no suggestion', () => {
    const body = 'Consider adding error handling for this edge case.';
    const result = extractCopilotPrompt(body);
    expect(result.confidence).toBe('low');
    expect(result.pattern).toBe('copilot_description');
  });

  it('returns absent for very short body', () => {
    const body = 'LGTM';
    const result = extractCopilotPrompt(body);
    expect(result.confidence).toBe('absent');
  });
});

describe('extractCodexPrompt', () => {
  it('removes badge and feedback prompt', () => {
    const body = `**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-minor-yellow)</sub></sub> Missing null check**

The function should validate input before processing.

Useful? React with 👍 or 👎`;
    
    const result = extractCodexPrompt(body);
    expect(result.prompt).toContain('Missing null check');
    expect(result.prompt).toContain('validate input');
    expect(result.prompt).not.toContain('Useful?');
    expect(result.prompt).not.toContain('Badge');
    expect(result.confidence).toBe('low');
    expect(result.pattern).toBe('codex_description');
  });

  it('returns absent for short content', () => {
    const body = '**OK**';
    const result = extractCodexPrompt(body);
    expect(result.confidence).toBe('absent');
  });
});

describe('cleanPrompt', () => {
  it('removes HTML tags', () => {
    const raw = '<b>Important</b> text <br/> here';
    expect(cleanPrompt(raw)).toBe('Important text here');
  });

  it('removes bold markdown', () => {
    const raw = 'This is **bold** text';
    expect(cleanPrompt(raw)).toBe('This is bold text');
  });

  it('preserves code block indentation', () => {
    const raw = `Description:
\`\`\`
  const x = 1;
    const y = 2;
\`\`\``;
    const cleaned = cleanPrompt(raw);
    expect(cleaned).toContain('  const x = 1;');
    expect(cleaned).toContain('    const y = 2;');
  });

  it('normalizes spaces outside code blocks', () => {
    const raw = 'Multiple    spaces   here';
    expect(cleanPrompt(raw)).toBe('Multiple spaces here');
  });

  it('handles undefined', () => {
    expect(cleanPrompt(undefined)).toBe('');
  });

  it('handles empty string', () => {
    expect(cleanPrompt('')).toBe('');
  });
});

describe('extractTitle', () => {
  describe('Gemini source', () => {
    it('extracts first sentence after badge', () => {
      const body = '![high](https://gstatic.com/...) This is the issue. More details here.';
      const title = extractTitle(body, 'gemini');
      expect(title).toBe('This is the issue.');
    });

    it('truncates long titles', () => {
      const body = '![low](https://gstatic.com/...) ' + 'A'.repeat(200);
      const title = extractTitle(body, 'gemini');
      expect(title.length).toBeLessThanOrEqual(100);
    });
  });

  describe('CodeRabbit/default source', () => {
    it('extracts bold text', () => {
      const body = '**Missing null check** in function foo()';
      const title = extractTitle(body);
      expect(title).toBe('Missing null check');
    });

    it('extracts heading', () => {
      const body = '## Issue Title\n\nDescription here';
      const title = extractTitle(body);
      expect(title).toBe('Issue Title');
    });

    it('falls back to first line', () => {
      const body = 'Simple comment without formatting\nMore lines here';
      const title = extractTitle(body);
      expect(title).toBe('Simple comment without formatting');
    });
  });

  it('handles null body', () => {
    expect(extractTitle(null)).toBe('N/A');
  });

  it('handles undefined body', () => {
    expect(extractTitle(undefined)).toBe('N/A');
  });
});

describe('truncateBody', () => {
  it('returns body unchanged if shorter than maxLength', () => {
    const body = 'Short text';
    expect(truncateBody(body, 500)).toBe('Short text');
  });

  it('truncates at word boundary', () => {
    const body = 'This is a longer text that needs to be truncated properly';
    const result = truncateBody(body, 30);
    expect(result).toMatch(/\.\.\.$/);
    expect(result.length).toBeLessThanOrEqual(33); // 30 + "..."
  });

  it('uses default maxLength of 500', () => {
    const body = 'A'.repeat(600);
    const result = truncateBody(body);
    expect(result.length).toBe(503); // 500 + "..."
  });

  it('handles null body', () => {
    expect(truncateBody(null)).toBe('');
  });

  it('handles undefined body', () => {
    expect(truncateBody(undefined)).toBe('');
  });

  it('breaks at word boundary when possible', () => {
    // Function breaks at last space within 80% of maxLength
    // For maxLength=50: 80% = 40, so looks for space within first 50 chars
    const body = 'short word another bigger sentence continues here and more text follows';
    const result = truncateBody(body, 50);
    expect(result.endsWith('...')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(53); // max + "..."
  });
});
