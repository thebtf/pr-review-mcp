/**
 * Unit tests for multi-issue detection and splitting
 */

import { describe, it, expect } from 'vitest';
import { detectMultiIssue, generateChildId, splitMultiIssue } from './multi-issue.js';
import type { ProcessedComment } from '../github/types.js';

describe('detectMultiIssue', () => {
  it('returns false for single issue', () => {
    const body = `Some comment
🤖 **Prompt for AI Agents**
Fix this bug`;
    expect(detectMultiIssue(body)).toBe(false);
  });

  it('returns true for multiple issues', () => {
    const body = `🤖 **Prompt for AI Agents**
First issue

🤖 **Prompt for AI Agents**
Second issue`;
    expect(detectMultiIssue(body)).toBe(true);
  });

  it('returns true for three or more issues', () => {
    const body = `🤖 Prompt for AI Agents
Issue 1

🤖 Prompt for AI Agents
Issue 2

🤖 Prompt for AI Agents
Issue 3`;
    expect(detectMultiIssue(body)).toBe(true);
  });

  it('handles variations in formatting', () => {
    // With bold markers
    const body1 = `🤖 **Prompt for AI Agents**
First

🤖 **Prompt for AI Agents**
Second`;
    expect(detectMultiIssue(body1)).toBe(true);

    // Without bold markers
    const body2 = `🤖 Prompt for AI Agents
First

🤖 Prompt for AI Agents
Second`;
    expect(detectMultiIssue(body2)).toBe(true);

    // Mixed
    const body3 = `🤖 **Prompt for AI Agents**
First

🤖 Prompt for AI Agents
Second`;
    expect(detectMultiIssue(body3)).toBe(true);
  });

  it('returns false for body without AI prompts', () => {
    const body = 'Just a regular comment without any AI prompts';
    expect(detectMultiIssue(body)).toBe(false);
  });

  it('returns false for empty body', () => {
    expect(detectMultiIssue('')).toBe(false);
  });
});

describe('generateChildId', () => {
  it('generates deterministic ID', () => {
    const parentId = 'parent-123';
    const issueBlock = 'Fix the null check';
    
    const id1 = generateChildId(parentId, issueBlock);
    const id2 = generateChildId(parentId, issueBlock);
    
    expect(id1).toBe(id2);
  });

  it('generates different IDs for different content', () => {
    const parentId = 'parent-123';
    
    const id1 = generateChildId(parentId, 'First issue');
    const id2 = generateChildId(parentId, 'Second issue');
    
    expect(id1).not.toBe(id2);
  });

  it('includes parent ID in result', () => {
    const parentId = 'parent-123';
    const id = generateChildId(parentId, 'Some content');
    
    expect(id.startsWith('parent-123-child-')).toBe(true);
  });

  it('uses 12-character hash', () => {
    const id = generateChildId('parent', 'content');
    // Format: parent-child-<12-char-hash>
    const parts = id.split('-child-');
    expect(parts[1].length).toBe(12);
  });

  it('trims whitespace before hashing', () => {
    const parentId = 'parent';
    
    const id1 = generateChildId(parentId, '  content  ');
    const id2 = generateChildId(parentId, 'content');
    
    expect(id1).toBe(id2);
  });
});

describe('splitMultiIssue', () => {
  const createMockParent = (): ProcessedComment => ({
    id: 'parent-123',
    threadId: 'thread-456',
    title: 'Parent Title',
    body: 'Original body',
    fullBody: 'Original body',
    file: 'src/test.ts',
    line: 10,
    resolved: false,
    outdated: false,
    canResolve: true,
    author: 'coderabbitai[bot]',
    source: 'coderabbit',
    severity: 'MINOR',
    type: 'issue',
    aiPrompt: null,
    aiPromptConfidence: 'absent',
    createdAt: undefined,
    updatedAt: undefined,
    replies: []
  });

  it('splits body into multiple comments', () => {
    const parent = createMockParent();
    const body = `🤖 **Prompt for AI Agents**
Fix the first bug

🤖 **Prompt for AI Agents**
Fix the second bug`;

    const children = splitMultiIssue(parent, body);

    expect(children.length).toBe(2);
  });

  it('assigns unique IDs to children', () => {
    const parent = createMockParent();
    const body = `🤖 Prompt for AI Agents
Issue one

🤖 Prompt for AI Agents
Issue two`;

    const children = splitMultiIssue(parent, body);

    expect(children[0].id).not.toBe(children[1].id);
    expect(children[0].id).toContain(parent.id);
    expect(children[1].id).toContain(parent.id);
  });

  it('links children to parent via parentId', () => {
    const parent = createMockParent();
    const body = `🤖 Prompt for AI Agents
First

🤖 Prompt for AI Agents
Second`;

    const children = splitMultiIssue(parent, body);

    expect(children[0].parentId).toBe(parent.id);
    expect(children[1].parentId).toBe(parent.id);
  });

  it('preserves parent properties in children', () => {
    const parent = createMockParent();
    const body = `🤖 Prompt for AI Agents
First issue`;

    // Single issue - should return parent unchanged
    const children = splitMultiIssue(parent, body);

    expect(children[0].file).toBe(parent.file);
    expect(children[0].line).toBe(parent.line);
    expect(children[0].author).toBe(parent.author);
    expect(children[0].source).toBe(parent.source);
  });

  it('generates indexed titles', () => {
    const parent = createMockParent();
    const body = `🤖 Prompt for AI Agents
First

🤖 Prompt for AI Agents
Second

🤖 Prompt for AI Agents
Third`;

    const children = splitMultiIssue(parent, body);

    expect(children[0].title).toBe('Issue 1/3: Parent Title');
    expect(children[1].title).toBe('Issue 2/3: Parent Title');
    expect(children[2].title).toBe('Issue 3/3: Parent Title');
  });

  it('sets body and fullBody to section content', () => {
    const parent = createMockParent();
    const body = `🤖 Prompt for AI Agents
First issue content

🤖 Prompt for AI Agents
Second issue content`;

    const children = splitMultiIssue(parent, body);

    expect(children[0].body).toContain('First issue content');
    expect(children[1].body).toContain('Second issue content');
    expect(children[0].fullBody).toBe(children[0].body);
  });

  it('returns original parent for single-issue body', () => {
    const parent = createMockParent();
    const body = `🤖 Prompt for AI Agents
Only one issue here`;

    const result = splitMultiIssue(parent, body);

    expect(result.length).toBe(1);
    expect(result[0]).toBe(parent); // Same reference
  });

  it('filters empty sections', () => {
    const parent = createMockParent();
    // Body with some empty content between prompts
    const body = `Introduction text

🤖 Prompt for AI Agents
Actual issue`;

    const result = splitMultiIssue(parent, body);

    // Should only contain sections with AI prompt header
    expect(result.length).toBe(1);
  });

  it('clears replies for child comments', () => {
    const parent = createMockParent();
    parent.replies = [
      { id: 'reply-1', body: 'Reply 1', author: 'user', createdAt: '2024-01-01' },
      { id: 'reply-2', body: 'Reply 2', author: 'user', createdAt: '2024-01-01' }
    ];
    
    const body = `🤖 Prompt for AI Agents
First

🤖 Prompt for AI Agents
Second`;

    const children = splitMultiIssue(parent, body);

    expect(children[0].replies).toEqual([]);
    expect(children[1].replies).toEqual([]);
  });
});
