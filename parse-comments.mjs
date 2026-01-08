import fs from 'fs';
const filePath = 'C:/Users/btf/.claude/projects/D--Dev-agent-skills/23171329-5597-4650-974c-9b280b66931f/tool-results/mcp-coderabbitai-get_review_comments-1767910352288.txt';
const data = JSON.parse(fs.readFileSync(filePath));
const comments = JSON.parse(data[0].text);

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
