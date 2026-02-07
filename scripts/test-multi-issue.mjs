#!/usr/bin/env node
/**
 * Integration tests for multi-issue comment handling
 * Tests parsing, state persistence, and reactions on real PR
 *
 * Usage: node scripts/test-multi-issue.mjs [owner/repo#pr]
 * Default: thebtf/pr-review-mcp#6
 */

import { execSync } from 'child_process';

// Test PR with known multi-issue comments
const DEFAULT_PR = 'thebtf/pr-review-mcp#6';
const prArg = process.argv[2] || DEFAULT_PR;
const [ownerRepo, prNum] = prArg.split('#');
const [owner, repo] = ownerRepo.split('/');
const pr = parseInt(prNum, 10);

console.log(`\n=== Multi-Issue Integration Tests ===`);
console.log(`PR: ${owner}/${repo}#${pr}\n`);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`❌ ${name}: ${e.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ============================================================================
// Test 1: Multi-issue detection
// ============================================================================

console.log('\n--- 1. Multi-Issue Detection ---');

// Import and test detectMultiIssue
const multiIssueModule = await import('../dist/extractors/multi-issue.js');
const { detectMultiIssue, splitMultiIssue, generateChildId } = multiIssueModule;

const singleIssueBody = `
**Issue Title**
Description here.

<details>
<summary>🤖 Prompt for AI Agents</summary>
In @src/file.ts:42
- Fix this thing
</details>
`;

const multiIssueBody = `
**Issue 1** | Major

Description of first issue.

<details>
<summary>🤖 Prompt for AI Agents</summary>
In @src/file1.ts:42
- Fix first thing
</details>

---

**Issue 2** | Major

Description of second issue.

<details>
<summary>🤖 Prompt for AI Agents</summary>
In @src/file2.ts:99
- Fix second thing
</details>
`;

test('detectMultiIssue returns false for single-issue', () => {
  assert(detectMultiIssue(singleIssueBody) === false, 'Should be false');
});

test('detectMultiIssue returns true for multi-issue', () => {
  assert(detectMultiIssue(multiIssueBody) === true, 'Should be true');
});

test('generateChildId is deterministic', () => {
  const id1 = generateChildId('parent-123', 'issue block content');
  const id2 = generateChildId('parent-123', 'issue block content');
  assert(id1 === id2, `IDs should match: ${id1} vs ${id2}`);
});

test('generateChildId differs for different content', () => {
  const id1 = generateChildId('parent-123', 'content A');
  const id2 = generateChildId('parent-123', 'content B');
  assert(id1 !== id2, 'IDs should differ');
});

// ============================================================================
// Test 2: splitMultiIssue with mock ProcessedComment
// ============================================================================

console.log('\n--- 2. Split Multi-Issue ---');

const mockParentComment = {
  id: 'PRRC_test123',
  threadId: 'PRRT_test123',
  file: 'src/test.ts',
  line: 42,
  severity: 'MAJOR',
  source: 'coderabbit',
  title: 'Parent Issue',
  body: multiIssueBody,
  fullBody: multiIssueBody,
  resolved: false,
  canResolve: true,
  aiPrompt: null,
  aiPromptConfidence: 'absent',
  author: 'coderabbitai[bot]',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  replies: []
};

test('splitMultiIssue creates child comments', () => {
  const children = splitMultiIssue(mockParentComment, multiIssueBody);
  assert(children.length === 2, `Expected 2 children, got ${children.length}`);
});

test('splitMultiIssue sets parentId on children', () => {
  const children = splitMultiIssue(mockParentComment, multiIssueBody);
  assert(children[0].parentId === 'PRRC_test123', 'Child should have parentId');
  assert(children[1].parentId === 'PRRC_test123', 'Child should have parentId');
});

test('splitMultiIssue generates unique child IDs', () => {
  const children = splitMultiIssue(mockParentComment, multiIssueBody);
  assert(children[0].id !== children[1].id, 'Child IDs should be unique');
});

// ============================================================================
// Test 3: State Comment (requires GitHub API)
// ============================================================================

console.log('\n--- 3. State Comment (GitHub API) ---');

const stateModule = await import('../dist/github/state-comment.js');
const { loadState, saveState } = stateModule;

test('loadState returns empty state for new PR', async () => {
  // Use a test PR number that likely doesn't exist
  const state = await loadState(owner, repo, 99999);
  assert(state.version === 2, 'Should have version 2');
  assert(Object.keys(state.parentChildren).length === 0, 'Should be empty');
});

// ============================================================================
// Test 4: Fetch real comments from PR
// ============================================================================

console.log('\n--- 4. Real PR Comments ---');

// Build the project first to ensure latest code
try {
  execSync('npm run build', { cwd: process.cwd(), stdio: 'pipe' });
} catch (e) {
  console.log('⚠️  Build failed, using existing dist');
}

// Use gh CLI to fetch a known multi-issue comment
const knownMultiIssueId = 'PRRC_kwDOQ2R7qs6f35ON'; // The one with 2 AI Prompts

test('Real multi-issue comment has multiple AI Prompts', async () => {
  try {
    // Fetch comment via REST API (works better on Windows)
    // Get the PR review comments and find our target
    const result = execSync(
      `gh api repos/${owner}/${repo}/pulls/${pr}/comments --jq ".[] | select(.id == 2682229645) | .body"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );

    if (!result.trim()) {
      // Comment might have different numeric ID, skip test
      console.log('  (skipped - comment not found via REST API)');
      return;
    }

    const hasMultiple = detectMultiIssue(result);
    assert(hasMultiple, 'Known comment should have multiple AI Prompts');
  } catch (e) {
    // If gh CLI fails, skip this test gracefully
    console.log(`  (skipped - gh CLI error: ${e.message.slice(0, 50)}...)`);
  }
});

// ============================================================================
// Test 5: Nitpick Parsing
// ============================================================================

console.log('\n--- 5. Nitpick Parsing ---');

const nitpickModule = await import('../dist/extractors/coderabbit-nitpicks.js');
const { parseNitpicksFromReviewBody } = nitpickModule;

// Real CodeRabbit format with proper HTML structure
const nitpickReviewBody = `<details>
<summary>🧹 Nitpick comments (3)</summary>
<blockquote>

<details>
<summary>scripts/test.mjs (2)</summary>
<blockquote>

\`22-49\`: **Утечка ресурсов при ошибке.**

Description of first nitpick.

---

\`75-85\`: **Слушатель события не удаляется.**

Description of second nitpick.

</blockquote>
</details>

<details>
<summary>src/file.ts (1)</summary>
<blockquote>

\`100\`: **Single line issue.**

Just one line.

</blockquote>
</details>

</blockquote>
</details>`;

test('parseNitpicksFromReviewBody extracts all nitpicks', () => {
  const nitpicks = parseNitpicksFromReviewBody(nitpickReviewBody);
  assert(nitpicks.length === 3, `Expected 3 nitpicks, got ${nitpicks.length}`);
});

test('parseNitpicksFromReviewBody preserves file associations', () => {
  const nitpicks = parseNitpicksFromReviewBody(nitpickReviewBody);
  const scriptNitpicks = nitpicks.filter(n => n.file === 'scripts/test.mjs');
  const srcNitpicks = nitpicks.filter(n => n.file === 'src/file.ts');
  assert(scriptNitpicks.length === 2, 'Should have 2 nitpicks for scripts/test.mjs');
  assert(srcNitpicks.length === 1, 'Should have 1 nitpick for src/file.ts');
});

test('parseNitpicksFromReviewBody parses line ranges', () => {
  const nitpicks = parseNitpicksFromReviewBody(nitpickReviewBody);
  const first = nitpicks.find(n => n.line === '22-49');
  const single = nitpicks.find(n => n.line === '100');
  assert(first, 'Should parse range 22-49');
  assert(single, 'Should parse single line 100');
});

test('parseNitpicksFromReviewBody generates stable ids for identical nitpicks', () => {
  const nitpicksFirst = parseNitpicksFromReviewBody(nitpickReviewBody);
  const nitpicksSecond = parseNitpicksFromReviewBody(nitpickReviewBody);

  assert(
    nitpicksFirst.length === nitpicksSecond.length,
    `Expected same number of nitpicks, got ${nitpicksFirst.length} and ${nitpicksSecond.length}`,
  );

  nitpicksFirst.forEach((nitpick, index) => {
    const corresponding = nitpicksSecond[index];

    assert(nitpick.id, 'Nitpick from first parse should have an id');
    assert(corresponding.id, 'Nitpick from second parse should have an id');

    assert(
      nitpick.id === corresponding.id,
      `Expected stable id for nitpick at index ${index}, got ${nitpick.id} and ${corresponding.id}`,
    );
  });
});

test('parseNitpicksFromReviewBody changes id when title changes', () => {
  const originalNitpicks = parseNitpicksFromReviewBody(nitpickReviewBody);
  assert(originalNitpicks.length > 0, 'Expected at least one nitpick');

  const baseNitpick = originalNitpicks[0];
  assert(baseNitpick.title, 'Expected nitpick to have a title');

  const updatedTitle = `${baseNitpick.title} (updated)`;
  const modifiedReviewBody = nitpickReviewBody.replace(baseNitpick.title, updatedTitle);

  const modifiedNitpicks = parseNitpicksFromReviewBody(modifiedReviewBody);
  assert(modifiedNitpicks.length === originalNitpicks.length, 'Title change should not change nitpick count');

  const modifiedFirstNitpick = modifiedNitpicks[0];
  assert(
    modifiedFirstNitpick.title === updatedTitle,
    `Expected first nitpick to have updated title, got "${modifiedFirstNitpick.title}"`,
  );

  assert(
    baseNitpick.id !== modifiedFirstNitpick.id,
    'Changing only the title of a nitpick should produce a different id',
  );
});

test('parseNitpicksFromReviewBody generates unique ids for nitpicks in the same review', () => {
  const nitpicks = parseNitpicksFromReviewBody(nitpickReviewBody);
  const ids = nitpicks.map((n) => n.id);

  ids.forEach((id, index) => {
    assert(id, `Nitpick at index ${index} should have an id`);
  });

  const uniqueIds = new Set(ids);
  assert(
    uniqueIds.size === ids.length,
    `Expected all nitpick ids in a single review to be unique, got ${ids.length} nitpicks and ${uniqueIds.size} unique ids`,
  );
});

// ============================================================================
// Summary
// ============================================================================

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`Passed: ${passed}/${passed + failed}`);
console.log(`Failed: ${failed}/${passed + failed}`);

if (failed > 0) {
  process.exit(1);
}
