/**
 * AI Prompt Extractor - Multi-source support
 * Sources: CodeRabbit, Gemini Code Assist, Codex
 */

import type { CommentSource } from '../github/types.js';

export type PromptConfidence = 'high' | 'low' | 'absent';

export interface PromptExtraction {
  prompt: string | null;
  confidence: PromptConfidence;
  pattern: string | null;
}

interface PatternDef {
  pattern: RegExp;
  confidence: 'high' | 'low';
  name: string;
  captureGroup: number;
}

// ============================================================================
// 4-Layer Pattern Definitions
// ============================================================================

const PROMPT_PATTERNS: PatternDef[] = [
  // Layer 1: Explicit AI prompt markers (HIGH confidence)
  {
    pattern: /<!--\s*ai[_-]?prompt\s*-->([\s\S]*?)<!--\s*\/ai[_-]?prompt\s*-->/i,
    confidence: 'high',
    name: 'explicit_marker',
    captureGroup: 1
  },

  // Layer 2: CodeRabbit's "🤖 Prompt for AI Agents" details block (HIGH confidence)
  // MUST have 🤖 emoji to distinguish from Analysis/Fix blocks
  {
    pattern: /<details>\s*<summary>\s*🤖[^<]*<\/summary>\s*```[^\n]*\n([\s\S]*?)```\s*<\/details>/i,
    confidence: 'high',
    name: 'coderabbit_details_prompt',
    captureGroup: 1
  },

  // Layer 2b: Standalone 🤖 header with code block (HIGH confidence)
  {
    pattern: /🤖\s*(?:Prompt for AI|AI Prompt|Agent Prompt)[^\n]*\n```[^\n]*\n([\s\S]*?)```/i,
    confidence: 'high',
    name: 'coderabbit_ai_block',
    captureGroup: 1
  },

  // Layer 3: Suggestion code blocks (LOW confidence) - treat as fallback
  // Note: These should ideally be extracted separately as "committable suggestions"
  {
    pattern: /```suggestion\n([\s\S]*?)```/,
    confidence: 'low',
    name: 'suggestion_block',
    captureGroup: 1
  },

  // Layer 3b: Diff blocks (LOW confidence)
  {
    pattern: /```diff\n([\s\S]*?)```/,
    confidence: 'low',
    name: 'diff_block',
    captureGroup: 1
  },

  // Layer 4: Actionable text heuristic (LOW confidence)
  // Only first sentence to avoid grabbing entire paragraphs
  {
    pattern: /(?:^|\n)\s*(?:Consider|Should|Must|Replace|Change|Add|Remove|Fix|Update|Refactor|Extract|Rename|Move|Delete|Ensure|Verify|Check|Validate)\s+[^.\n]+\./i,
    confidence: 'low',
    name: 'actionable_heuristic',
    captureGroup: 0
  }
];

// ============================================================================
// Main Extraction Functions
// ============================================================================

/**
 * Extract AI prompt from comment body
 * @param body - Comment body text
 * @param source - Comment source (coderabbit, gemini, codex, unknown)
 */
export function extractPrompt(body: string | null | undefined, source: CommentSource = 'unknown'): PromptExtraction {
  if (!body || typeof body !== 'string') {
    return { prompt: null, confidence: 'absent', pattern: null };
  }

  // Source-specific extraction
  if (source === 'gemini') {
    return extractGeminiPrompt(body);
  }

  if (source === 'codex') {
    return extractCodexPrompt(body);
  }

  // CodeRabbit and unknown: use pattern matching
  for (const { pattern, confidence, name, captureGroup } of PROMPT_PATTERNS) {
    const match = body.match(pattern);
    if (match) {
      const extracted = match[captureGroup] || match[0];
      const cleaned = cleanPrompt(extracted);

      if (cleaned && cleaned.length > 10) {
        return {
          prompt: cleaned,
          confidence,
          pattern: name
        };
      }
    }
  }

  return { prompt: null, confidence: 'absent', pattern: null };
}

/**
 * Extract prompt from Gemini Code Assist comments
 * Gemini doesn't have explicit AI prompts - the whole description is the instruction
 */
function extractGeminiPrompt(body: string): PromptExtraction {
  // Remove the severity badge
  const cleaned = body
    .replace(/!\[(critical|high|medium|low)\]\([^)]+\)/gi, '')
    .trim();

  if (cleaned.length < 20) {
    return { prompt: null, confidence: 'absent', pattern: null };
  }

  return {
    prompt: cleaned,
    confidence: 'low', // Gemini doesn't have explicit AI prompts
    pattern: 'gemini_description'
  };
}

/**
 * Extract prompt from Codex comments
 * Format: **<sub><sub>![P2 Badge](...)</sub></sub> Title**\n\nDescription\n\nUseful? React with...
 */
function extractCodexPrompt(body: string): PromptExtraction {
  // Remove badge and formatting
  let cleaned = body
    // Remove sub tags and badge
    .replace(/<sub><sub>!\[P\d\s*Badge\][^)]+\)<\/sub><\/sub>/gi, '')
    // Remove bold wrapper around title
    .replace(/^\*\*\s*/, '')
    .replace(/\s*\*\*\n/, '\n')
    // Remove feedback prompt
    .replace(/\n*Useful\?\s*React with.*$/i, '')
    .trim();

  if (cleaned.length < 20) {
    return { prompt: null, confidence: 'absent', pattern: null };
  }

  return {
    prompt: cleaned,
    confidence: 'low', // Codex doesn't have explicit AI prompts
    pattern: 'codex_description'
  };
}

/**
 * Clean extracted prompt while preserving code block indentation
 */
function cleanPrompt(raw: string | undefined): string {
  if (!raw) return '';

  // First pass: remove HTML tags and markdown formatting
  let cleaned = raw
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1');

  // Process line by line, preserving indentation in code blocks
  const lines = cleaned.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    // Toggle code block state on fence markers
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      result.push(line.trim());
      continue;
    }

    if (inCodeBlock) {
      // Preserve indentation inside code blocks
      result.push(line.trimEnd());
    } else {
      // Normalize spaces and trim outside code blocks
      result.push(line.replace(/[ \t]+/g, ' ').trim());
    }
  }

  return result.join('\n').trim();
}

/**
 * Extract issue title from comment body
 * @param body - Comment body text
 * @param source - Comment source (coderabbit, gemini, codex, unknown)
 */
export function extractTitle(body: string | null | undefined, source: CommentSource = 'unknown'): string {
  if (!body) return 'N/A';

  // Gemini: First sentence after badge
  if (source === 'gemini') {
    const cleaned = body.replace(/!\[(critical|high|medium|low)\]\([^)]+\)/gi, '').trim();
    const firstSentence = cleaned.match(/^([^.!?]+[.!?])/);
    if (firstSentence) {
      return firstSentence[1].slice(0, 100);
    }
    return cleaned.slice(0, 100);
  }

  // Try to get first bold text (CodeRabbit style)
  const boldMatch = body.match(/\*\*([^*]+)\*\*/);
  if (boldMatch) {
    return boldMatch[1].slice(0, 100);
  }

  // Try heading
  const headingMatch = body.match(/^#+\s*(.+)$/m);
  if (headingMatch) {
    return headingMatch[1].slice(0, 100);
  }

  // Fallback to first line
  const firstLine = body.split('\n')[0];
  return firstLine.slice(0, 100);
}

/**
 * Truncate body for summary
 */
export function truncateBody(body: string | null | undefined, maxLength = 500): string {
  if (!body) return '';
  if (body.length <= maxLength) return body;

  // Try to break at word boundary
  const truncated = body.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');

  if (lastSpace > maxLength * 0.8) {
    return truncated.slice(0, lastSpace) + '...';
  }

  return truncated + '...';
}
