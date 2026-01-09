import { createHash } from 'crypto';
import type { ProcessedComment } from '../github/types.js';
import { extractPrompt, truncateBody } from './prompt.js';

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
 * Generate a consistent ID for a nitpick
 */
function generateNitpickId(reviewId: string, file: string, lineStart: string | number): string {
  const fileHash = createHash('md5').update(file).digest('hex').slice(0, 8);
  return `coderabbit-nitpick-${reviewId}-${fileHash}-${lineStart}`;
}

/**
 * Parse nitpick comments from CodeRabbit review body
 */
export function parseNitpicksFromReviewBody(reviewId: string, body: string): NitpickComment[] {
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
      const id = generateNitpickId(reviewId, file, lineStart);
      
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
