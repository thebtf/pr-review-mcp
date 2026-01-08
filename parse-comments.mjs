#!/usr/bin/env node
/**
 * Parse CodeRabbit comments from MCP tool output file
 * Usage: node parse-comments.mjs <path-to-json-file>
 */
import fs from 'fs';

const filePath = process.argv[2];

if (!filePath) {
  console.error('Usage: node parse-comments.mjs <path-to-json-file>');
  process.exit(1);
}

if (!fs.existsSync(filePath)) {
  console.error(`Error: File not found: ${filePath}`);
  process.exit(1);
}

let data, comments;
try {
  const raw = fs.readFileSync(filePath, 'utf-8');
  data = JSON.parse(raw);
  comments = JSON.parse(data[0]?.text || '[]');
} catch (e) {
  console.error(`Error parsing file: ${e.message}`);
  process.exit(1);
}

// Group by severity
const bySeverity = {};
comments.filter(c => !c.is_resolved).forEach(c => {
  const sev = c.severity || 'unknown';
  bySeverity[sev] = (bySeverity[sev] || 0) + 1;
});

console.log('Summary:');
console.log('  Total:', comments.length);
console.log('  Open:', comments.filter(c => !c.is_resolved).length);
console.log('  By severity:', bySeverity);

console.log('\n--- MAJOR issues ---');
comments.filter(c => !c.is_resolved && c.severity === 'major').forEach((c, i) => {
  console.log(`${i+1}. ${c.path}`);
  console.log(`   ${c.description}`);
  if (c.ai_prompt) console.log(`   AI: ${c.ai_prompt.slice(0, 80)}...`);
  console.log();
});

console.log('\n--- MINOR issues ---');
comments.filter(c => !c.is_resolved && c.severity === 'minor').forEach((c, i) => {
  console.log(`${i+1}. ${c.path}: ${c.description}`);
});
