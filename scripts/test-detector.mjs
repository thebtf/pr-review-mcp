/**
 * Test script for agent detection
 * Usage: node scripts/test-detector.mjs owner repo pr
 * Example: node scripts/test-detector.mjs thebtf mcpm.sh 1
 */

import { GitHubClient } from '../dist/github/client.js';
import { detectReviewedAgents } from '../dist/agents/detector.js';

const [,, owner, repo, prStr] = process.argv;

if (!owner || !repo || !prStr) {
  console.error('Usage: node scripts/test-detector.mjs <owner> <repo> <pr>');
  console.error('Example: node scripts/test-detector.mjs thebtf mcpm.sh 1');
  process.exit(1);
}

const pr = parseInt(prStr, 10);
if (isNaN(pr)) {
  console.error('PR number must be a valid integer');
  process.exit(1);
}

console.log(`\n🔍 Detecting agents for ${owner}/${repo}#${pr}...\n`);

const client = new GitHubClient();
const result = await detectReviewedAgents(client, owner, repo, pr);

console.log('📊 Detection Results:');
console.log('─'.repeat(50));

console.log('\n✅ REVIEWED agents (already completed review):');
if (result.reviewed.size === 0) {
  console.log('   (none)');
} else {
  for (const agentId of result.reviewed) {
    const detail = result.details.find(d => d.agentId === agentId && d.status === 'reviewed');
    console.log(`   • ${agentId} (by ${detail?.reviewAuthor || 'unknown'})`);
  }
}

console.log('\n⏳ PENDING agents (requested or in-progress):');
if (result.pending.size === 0) {
  console.log('   (none)');
} else {
  for (const agentId of result.pending) {
    const detail = result.details.find(d => d.agentId === agentId && d.status === 'pending');
    console.log(`   • ${agentId} (by ${detail?.reviewAuthor || 'unknown'})`);
  }
}

console.log('\n📋 All details:');
console.log(JSON.stringify(result.details, null, 2));

console.log('\n─'.repeat(50));
console.log(`Total: ${result.reviewed.size} reviewed, ${result.pending.size} pending`);
