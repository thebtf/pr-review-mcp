import { createHash } from 'crypto';
import type { ProcessedComment } from '../github/types.js';
import { extractPrompt, truncateBody } from './prompt.js';

// ============================================================================
// Russian Positive Patterns (for filtering non-actionable compliments)
// ============================================================================

/**
 * Prefixes indicating positive/complimentary comments (not actionable)
 */
const RUSSIAN_POSITIVE_PREFIXES = /^(отличн|хорош|корректн|чист|надёжн|правильн)/i;

/**
 * Pattern for positive adjective + noun combinations
 * e.g., "Хорошая документация", "Отличное покрытие"
 */
const RUSSIAN_POSITIVE_ADJ_NOUN = /\b(отличн|хорош|корректн|чист|надёжн)\w*\s+(дополнени|документаци|реализаци|интеграци|дизайн|покрыти|тест|логик|управлени|инициализаци|захват|защит|поддержк|освобождени|расширени|улучшени|помет)/i;

/**
 * Suffixes indicating correctness confirmation
 */
const RUSSIAN_CORRECT_SUFFIXES = ['корректны.', 'корректно.', 'корректен.'];

/**
 * Pattern for "X is correct" format
 * e.g., "Импорты корректны", "Реализация корректна"
 */
const RUSSIAN_SUBJECT_CORRECT = /^(импорты|тесты|реализация|метод|конструктор|helper|порядок)\s+(reactiveui\s+)?корректн/i;

/**
 * Check if title matches Russian positive patterns (compliments, not actionable)
 */
function isRussianPositiveComment(title: string): boolean {
  return RUSSIAN_POSITIVE_PREFIXES.test(title) ||
         RUSSIAN_POSITIVE_ADJ_NOUN.test(title) ||
         RUSSIAN_CORRECT_SUFFIXES.some(suffix => title.endsWith(suffix)) ||
         RUSSIAN_SUBJECT_CORRECT.test(title);
}

// ============================================================================
// Types
// ============================================================================

export interface NitpickComment {
  id: string;
  threadId: string;      // same as id
  file: string;
  line: number | string; // first line or "X-Y" range
  severity: 'MINOR';     // always MINOR for nitpicks
  source: 'coderabbit';
  title: string;         // bold text after line range
  body: string;          // full nitpick body (truncated for display)
  fullBody: string;      // complete body
  resolved: false;       // nitpicks can't be resolved via API
  canResolve: false;
  hasAiPrompt: boolean;  // true if body contains AI prompt section
  aiPrompt: string | null;
  aiPromptConfidence: 'high' | 'low' | 'absent';
}

/**
 * Generate a content-based ID for a nitpick or outside-diff comment.
 * Uses file:lineStart:title as fingerprint — NOT reviewId.
 * This deduplicates identical comments across multiple CodeRabbit review passes,
 * since the same nitpick re-appears with a different reviewId on each push.
 * Body is intentionally excluded: LLM-generated bodies vary between passes.
 */
function generateCommentId(prefix: string, file: string, lineStart: string | number, title: string): string {
  const contentHash = createHash('md5').update(`${file}:${lineStart}:${title}`).digest('hex').slice(0, 8);
  return `${prefix}-${contentHash}-${lineStart}`;
}

/**
 * Generate a content-based ID for a nitpick
 */
function generateNitpickId(file: string, lineStart: string | number, title: string): string {
  return generateCommentId('coderabbit-nitpick', file, lineStart, title);
}

/**
 * Parse nitpick comments from CodeRabbit review body
 */
export function parseNitpicksFromReviewBody(body: string): NitpickComment[] {
  const nitpicks: NitpickComment[] = [];

  if (!body) return [];

  // 1. Find the "Nitpick comments" section
  // Regex to capture the content inside the outer <details>...<blockquote>...</blockquote></details>
  // The summary usually contains "Nitpick comments" (and potentially an emoji like 🧹)
  // IMPORTANT: Use GREEDY ([\s\S]*) to capture up to the LAST </blockquote></details>,
  // otherwise non-greedy stops at nested file section closings.
  const outerSectionMatch = body.match(/<details[^>]*>\s*<summary[^>]*>[^<]*Nitpick comments[^<]*<\/summary>\s*<blockquote[^>]*>([\s\S]*)<\/blockquote>\s*<\/details>/i);

  if (!outerSectionMatch) {
    return [];
  }

  const innerContent = outerSectionMatch[1];

  // 2. Split by file sections (nested <details>)
  // Each file section looks like: <details><summary>path/to/file (count)</summary><blockquote>...</blockquote></details>
  // We use a regex to find each file block.
  // Note: We use [\s\S]*? to be non-greedy and stop at the first </blockquote></details> pair.
  const fileSectionRegex = /<details[^>]*>\s*<summary[^>]*>(.*?)\s*\(\d+\)<\/summary>\s*<blockquote[^>]*>([\s\S]*?)<\/blockquote>\s*<\/details>/gi;

  let fileMatch;
  while ((fileMatch = fileSectionRegex.exec(innerContent)) !== null) {
    const file = fileMatch[1].trim();
    const fileContent = fileMatch[2];

    // 3. Parse individual nitpicks within the file section
    // Nitpicks structure:
    // `line-range`: **Title**
    // Body...
    // (Optional) <details>...Suggestion...</details>
    
    // We identify nitpicks by the starting pattern: `line` or `start-end`: **Title**
    // regex: `(\d+(?:-\d+)?)`:\s*\*\*(.*?)\*\*
    
    const nitpickStartRegex = /`(\d+(?:-\d+)?)`:\s*\*\*(.*?)\*\*/g;
    const starts: { index: number, line: string, title: string }[] = [];
    let startMatch;
    
    while ((startMatch = nitpickStartRegex.exec(fileContent)) !== null) {
      starts.push({
        index: startMatch.index,
        line: startMatch[1],
        title: startMatch[2]
      });
    }
    
    if (starts.length === 0) continue;

    for (let i = 0; i < starts.length; i++) {
      const start = starts[i];
      const nextStart = starts[i + 1];
      const endIndex = nextStart ? nextStart.index : fileContent.length;
      
      // Extract the block for this nitpick
      const rawBlock = fileContent.slice(start.index, endIndex);
      
      // Remove the header (`line`: **Title**) from the body
      // We reconstruct the header pattern to remove it cleanly
      const headerMatch = rawBlock.match(/^`(\d+(?:-\d+)?)`:\s*\*\*(.*?)\*\*/);
      let bodyContent = rawBlock;
      if (headerMatch) {
        bodyContent = rawBlock.slice(headerMatch[0].length).trim();
      }

      // 4. Extract AI prompt info
      // We pass 'coderabbit' as source to leverage specific patterns if any, 
      // although extractPrompt handles generic patterns too.
      const { prompt, confidence } = extractPrompt(bodyContent, 'coderabbit');
      
      // 5. Create the NitpickComment object
      // Use the start line for the ID to ensure uniqueness per file+review
      const lineStart = start.line.split('-')[0];
      const id = generateNitpickId(file, lineStart, start.title);
      
      nitpicks.push({
        id,
        threadId: id,
        file,
        line: start.line,
        severity: 'MINOR',
        source: 'coderabbit',
        title: start.title,
        body: truncateBody(bodyContent, 200),
        fullBody: bodyContent,
        resolved: false,
        canResolve: false,
        hasAiPrompt: confidence !== 'absent',
        aiPrompt: prompt,
        aiPromptConfidence: confidence,
      });
    }
  }

  return nitpicks;
}

export interface OutsideDiffComment {
  id: string;
  threadId: string;
  file: string;
  line: number | string;
  severity: 'N/A';           // Outside diff range - severity unknown
  source: 'coderabbit';
  title: string;
  body: string;
  fullBody: string;
  resolved: false;           // Cannot be resolved via API
  canResolve: false;
  hasAiPrompt: boolean;
  aiPrompt: string | null;
  aiPromptConfidence: 'high' | 'low' | 'absent';
}

/**
 * Parse "Outside diff range comments" from CodeRabbit review body.
 * These are comments on code lines that weren't changed in the PR,
 * so GitHub can't display them as inline comments.
 */
export function parseOutsideDiffComments(body: string): OutsideDiffComment[] {
  const comments: OutsideDiffComment[] = [];

  if (!body) return [];

  // CodeRabbit wraps outside diff comments in markdown blockquote (lines start with "> ")
  // We need to strip the "> " prefix to properly parse the HTML structure
  const normalizedBody = body.replace(/^> ?/gm, '');

  // 1. Find the "Outside diff range comments" section
  // Structure: <details><summary>⚠️ Outside diff range comments (N)</summary><blockquote>...
  // Regex breakdown:
  //   <details[^>]*>           - Opening details tag with any attributes
  //   \s*<summary[^>]*>        - Opening summary tag (with whitespace)
  //   [^<]*Outside diff range comments[^<]* - Summary text containing target phrase
  //   <\/summary>              - Closing summary tag
  //   \s*<blockquote[^>]*>     - Opening blockquote tag (with whitespace)
  //   ([\s\S]*)                - GREEDY capture group: all content including newlines
  //   <\/blockquote>\s*<\/details> - Closing tags (matches LAST occurrence due to greedy *)
  const outerSectionMatch = normalizedBody.match(/<details[^>]*>\s*<summary[^>]*>[^<]*Outside diff range comments[^<]*<\/summary>\s*<blockquote[^>]*>([\s\S]*)<\/blockquote>\s*<\/details>/i);

  if (!outerSectionMatch) {
    return [];
  }

  const innerContent = outerSectionMatch[1];

  // 2. Split by file sections (nested <details>)
  // Each file section: <details><summary>path/to/file (count)</summary><blockquote>...</blockquote></details>
  const fileSectionRegex = /<details[^>]*>\s*<summary[^>]*>(.*?)\s*\(\d+\)<\/summary>\s*<blockquote[^>]*>([\s\S]*?)<\/blockquote>\s*<\/details>/gi;

  let fileMatch;
  while ((fileMatch = fileSectionRegex.exec(innerContent)) !== null) {
    const file = fileMatch[1].trim();
    const fileContent = fileMatch[2];

    // Skip "Additional comments" sections (LGTM acknowledgments, not actionable)
    if (file.includes('Additional comments') || file.startsWith('🔇')) {
      continue;
    }

    // 3. Parse individual comments within the file section
    // Format: `line-range`: **Title**\nBody...
    const commentStartRegex = /`(\d+(?:-\d+)?)`:\s*\*\*(.*?)\*\*/g;
    const starts: { index: number, line: string, title: string }[] = [];
    let startMatch;

    while ((startMatch = commentStartRegex.exec(fileContent)) !== null) {
      starts.push({
        index: startMatch.index,
        line: startMatch[1],
        title: startMatch[2]
      });
    }

    if (starts.length === 0) continue;

    for (let i = 0; i < starts.length; i++) {
      const start = starts[i];
      const nextStart = starts[i + 1];
      const endIndex = nextStart ? nextStart.index : fileContent.length;

      // Extract the block for this comment
      const rawBlock = fileContent.slice(start.index, endIndex);

      // Remove the header (`line`: **Title**) from the body
      const headerMatch = rawBlock.match(/^`(\d+(?:-\d+)?)`:\s*\*\*(.*?)\*\*/);
      let bodyContent = rawBlock;
      if (headerMatch) {
        bodyContent = rawBlock.slice(headerMatch[0].length).trim();
      }

      // 4. Extract AI prompt info
      const { prompt, confidence } = extractPrompt(bodyContent, 'coderabbit');

      // Skip LGTM/positive acknowledgment comments (not actionable)
      // These are compliments/approvals, not issues requiring action
      const title = start.title;
      const titleLower = title.toLowerCase();

      // English positive patterns
      if (titleLower.includes('lgtm') || title.startsWith('✅')) {
        continue;
      }

      // Russian positive patterns (compliments, not actionable)
      if (isRussianPositiveComment(title)) {
        continue;
      }

      // 5. Create the OutsideDiffComment object
      const lineStart = start.line.split('-')[0];
      const id = generateCommentId('coderabbit-outside-diff', file, lineStart, start.title);

      comments.push({
        id,
        threadId: id,
        file,
        line: start.line,
        severity: 'N/A',
        source: 'coderabbit',
        title: start.title,
        body: truncateBody(bodyContent, 200),
        fullBody: bodyContent,
        resolved: false,
        canResolve: false,
        hasAiPrompt: confidence !== 'absent',
        aiPrompt: prompt,
        aiPromptConfidence: confidence,
      });
    }
  }

  return comments;
}

/**
 * Convert OutsideDiffComment to ProcessedComment
 */
export function outsideDiffToProcessedComment(comment: OutsideDiffComment): ProcessedComment {
  return {
    id: comment.id,
    threadId: comment.threadId,
    file: comment.file,
    line: comment.line,
    outdated: false,
    resolved: comment.resolved,
    canResolve: comment.canResolve,
    severity: comment.severity,
    type: 'review_comment',
    source: comment.source,
    title: comment.title,
    body: comment.body,
    fullBody: comment.fullBody,
    aiPrompt: comment.aiPrompt,
    aiPromptConfidence: comment.aiPromptConfidence,
    author: 'coderabbitai',
    createdAt: undefined,
    updatedAt: undefined,
    replies: []
  };
}

/**
 * Convert NitpickComment to ProcessedComment
 */
export function nitpickToProcessedComment(nitpick: NitpickComment): ProcessedComment {
  return {
    id: nitpick.id,
    threadId: nitpick.threadId,
    file: nitpick.file,
    line: nitpick.line,
    outdated: false, // Nitpicks in the current review body are considered current
    resolved: nitpick.resolved,
    canResolve: nitpick.canResolve,
    severity: nitpick.severity,
    type: 'review_comment', 
    source: nitpick.source,
    title: nitpick.title,
    body: nitpick.body,
    fullBody: nitpick.fullBody,
    aiPrompt: nitpick.aiPrompt,
    aiPromptConfidence: nitpick.aiPromptConfidence,
    author: 'coderabbitai', 
    createdAt: undefined, 
    updatedAt: undefined,
    replies: []
  };
}
