#!/usr/bin/env node
/**
 * Analyze PR #100 comments to understand different suggestion types
 */

import { GitHubClient } from './dist/github/client.js';
import { prList } from './dist/tools/list.js';
import { prGet } from './dist/tools/get.js';

const owner = 'thebtf';
const repo = 'novascript';
const pr = 100;

console.log('📊 Analyzing PR #100 comment types\n');

const client = new GitHubClient();

// Get all comments
const list = await prList({ owner, repo, pr, max: 10 }, client);
console.log(`Found ${list.total} comments\n`);

// Analyze each comment
for (const comment of list.comments) {
  console.log('━'.repeat(70));
  console.log(`📍 ${comment.file}:${comment.line}`);
  console.log(`   Severity: ${comment.severity}`);
  console.log(`   Title: ${comment.title}`);
  console.log(`   Has AI Prompt: ${comment.hasAiPrompt}`);

  // Get full details
  const detail = await prGet({ owner, repo, pr, id: comment.id }, client);

  // Check for different suggestion types
  const body = detail.body || '';

  const hasAiPrompt = body.includes('Prompt for AI Agents') || body.includes('🤖 Prompt');
  const hasCommitSuggestion = body.includes('```suggestion') || body.includes('```diff');
  const hasCodeBlock = body.includes('```csharp') || body.includes('```cs') || body.includes('```typescript');

  console.log(`   Body contains:`);
  console.log(`     - AI Prompt section: ${hasAiPrompt}`);
  console.log(`     - Committable suggestion: ${hasCommitSuggestion}`);
  console.log(`     - Code block: ${hasCodeBlock}`);

  if (detail.aiPrompt) {
    console.log(`   Extracted AI Prompt (${detail.aiPrompt.confidence}):`);
    console.log(`     "${detail.aiPrompt.text.substring(0, 100)}..."`);
  }

  // Show snippet of body
  console.log(`   Body preview:`);
  const preview = body.substring(0, 300).replace(/\n/g, '\n     ');
  console.log(`     ${preview}...`);
  console.log();
}

console.log('━'.repeat(70));
console.log('✅ Analysis complete');
