#!/usr/bin/env node
import { GitHubClient } from './dist/github/client.js';
import { prList } from './dist/tools/list.js';
import { prGet } from './dist/tools/get.js';

const client = new GitHubClient();

// Check prerequisites
try {
  client.checkPrerequisites();
} catch (e) {
  console.error('❌ Prerequisites check failed:', e.message);
  process.exit(1);
}

// Fetch unresolved comment list
let list;
try {
  list = await prList({ owner: 'thebtf', repo: 'pr-review-mcp', pr: 2, filter: { resolved: false }, max: 10 }, client);
} catch (e) {
  console.error('❌ Failed to fetch comments:', e.message);
  process.exit(1);
}

console.log(`\n📋 ${list.comments.length} unresolved comments:\n`);

for (const c of list.comments) {
  let detail;
  try {
    detail = await prGet({ owner: 'thebtf', repo: 'pr-review-mcp', pr: 2, id: c.id }, client);
  } catch (e) {
    console.error(`❌ Failed to fetch detail for ${c.id}: ${e.message}`);
    continue;
  }
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`[${c.severity}] ${c.file}:${c.line}`);
  console.log(`Title: ${c.title}`);
  if (detail.aiPrompt?.text) {
    console.log(`\nAI Prompt:\n${detail.aiPrompt.text}\n`);
  } else {
    console.log(`\nNo AI prompt extracted\n`);
  }
}
