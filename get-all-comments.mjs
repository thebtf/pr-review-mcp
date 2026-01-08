#!/usr/bin/env node
import { GitHubClient } from './dist/github/client.js';
import { prList } from './dist/tools/list.js';
import { prGet } from './dist/tools/get.js';

const client = new GitHubClient();
const list = await prList({ owner: 'thebtf', repo: 'pr-review-mcp', pr: 2, max: 10 }, client);

console.log(`\n📋 ${list.total} comments to fix:\n`);

for (const c of list.comments) {
  const detail = await prGet({ owner: 'thebtf', repo: 'pr-review-mcp', pr: 2, id: c.id }, client);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`[${c.severity}] ${c.file}:${c.line}`);
  console.log(`Title: ${c.title}`);
  if (detail.aiPrompt?.text) {
    console.log(`\nAI Prompt:\n${detail.aiPrompt.text}\n`);
  } else {
    console.log(`\nNo AI prompt extracted\n`);
  }
}
