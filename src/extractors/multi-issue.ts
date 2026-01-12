import { createHash } from 'crypto';
import type { ProcessedComment } from '../github/types.js';

// Detect multiple AI Prompt sections
// Matches "🤖 **Prompt for AI Agents**" or similar variations
// Use 'g' flag only for counting matches, not for test()
const AI_PROMPT_PATTERN = /🤖\s*\*?\*?Prompt for AI Agents\*?\*?/gi;

// Non-global version for test() to avoid stateful lastIndex issues
const AI_PROMPT_TEST = /🤖\s*\*?\*?Prompt for AI Agents\*?\*?/i;

// Section delimiter - look for the "Prompt for AI Agents" header
// We use a lookahead or just splitting by the header
const SECTION_SPLIT_REGEX = /(?=🤖\s*\*?\*?Prompt for AI Agents\*?\*?)/i;

/**
 * Detect if a comment body contains multiple AI Prompt sections
 */
export function detectMultiIssue(body: string): boolean {
  const matches = body.match(AI_PROMPT_PATTERN);
  return matches !== null && matches.length > 1;
}

/**
 * Generate a deterministic ID for a child issue
 * Uses parent ID + SHA256 of the issue block content
 */
export function generateChildId(parentId: string, issueBlock: string): string {
  const hash = createHash('sha256')
    .update(issueBlock.trim())
    .digest('hex')
    .substring(0, 12);
  return `${parentId}-child-${hash}`;
}

/**
 * Split a multi-issue comment into separate ProcessedComment objects
 */
export function splitMultiIssue(parentComment: ProcessedComment, body: string): ProcessedComment[] {
  // Split by the AI Prompt header
  // Filter out empty sections (e.g. text before first prompt if any, though usually prompt is first or after brief intro)
  // Use non-global regex for test() to avoid stateful lastIndex issues
  const sections = body
    .split(SECTION_SPLIT_REGEX)
    .map(s => s.trim())
    .filter(s => s.length > 0 && AI_PROMPT_TEST.test(s));

  if (sections.length <= 1) {
    // Should generally not happen if detectMultiIssue passed, but handle gracefully
    return [parentComment];
  }

  const children: ProcessedComment[] = [];
  const childIds: string[] = [];

  sections.forEach((section, index) => {
    // Generate ID based on content
    const childId = generateChildId(parentComment.id, section);
    childIds.push(childId);

    // Extract title (first line of description usually, or generic)
    // We can reuse extractTitle logic or just take the first line of the block 
    // but the block starts with "🤖 **Prompt...".
    // The prompt itself usually contains the instruction.
    // Let's keep the body as the full section for now.
    
    // Create child comment
    const child: ProcessedComment = {
      ...parentComment,
      id: childId,
      threadId: childId, // Virtual thread ID
      parentId: parentComment.id, // Link to parent
      body: section,
      fullBody: section,
      // We might want to extract a specific title from the section
      title: `Issue ${index + 1}/${sections.length}: ${parentComment.title}`, 
      // Reset some fields
      replies: [],
      // Ensure source is preserved
      source: parentComment.source
    };
    
    // We need to re-extract the prompt for this specific section
    // But ProcessedComment already has aiPrompt field. 
    // We should probably allow the shared logic to extract it later or do it here.
    // For now, let's leave it to the consumer or just copy the full body.
    
    children.push(child);
  });

  // Update parent with child IDs (this will be done by the caller or we return a special parent copy?)
  // The caller (shared.ts) expects a list of comments.
  // We should return the children. 
  // The PARENT comment itself might not be needed in the list if we strictly want to work on children.
  // BUT the "parent" in this context is often a synthetic nitpick constructed from the review body.
  // So returning the children IS replacing the parent.
  
  // However, we need to register the parent-child relationship in stateManager.
  // We can't do that here easily without importing stateManager (which is fine).
  // Or let the caller do it.
  // The plan said: "Flatten child comments into main list".
  
  return children;
}
