#!/usr/bin/env node
/**
 * Automated MCP Feature Tests
 * Tests: Resources, Logging, Tool Annotations
 */

import { spawn } from 'child_process';
import * as readline from 'readline';

const TESTS = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  TESTS.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

class MCPClient {
  constructor() {
    this.messageId = 0;
    this.pendingRequests = new Map();
    this.logs = [];
  }

  async start() {
    this.server = spawn('node', ['dist/index.js'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd()
    });

    // Capture stderr (logs)
    this.server.stderr.on('data', (data) => {
      this.logs.push(data.toString());
    });

    // Handle responses
    const rl = readline.createInterface({ input: this.server.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const response = JSON.parse(line);
        if ('id' in response) {
          const pending = this.pendingRequests.get(response.id);
          if (pending) {
            pending.resolve(response);
            this.pendingRequests.delete(response.id);
          }
        }
      } catch (e) {}
    });

    await new Promise(r => setTimeout(r, 500));

    // Initialize
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    this.send('notifications/initialized', {});

    return this;
  }

  send(method, params = {}) {
    const id = ++this.messageId;
    const message = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.server.stdin.write(JSON.stringify(message) + '\n');
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Timeout'));
        }
      }, 10000);
    });
  }

  close() {
    this.server?.kill();
  }
}

// ============================================================================
// TESTS
// ============================================================================

test('tools/list returns 16 tools', async (client) => {
  const res = await client.send('tools/list', {});
  assert(res.result?.tools?.length === 16, `Expected 16 tools, got ${res.result?.tools?.length}`);
});

test('tools have annotations', async (client) => {
  const res = await client.send('tools/list', {});
  const withAnnotations = res.result.tools.filter(t => t.annotations);
  assert(withAnnotations.length === 16, `Expected 16 tools with annotations, got ${withAnnotations.length}`);
});

test('annotations have correct structure', async (client) => {
  const res = await client.send('tools/list', {});
  const tool = res.result.tools.find(t => t.name === 'pr_summary');
  assert(tool.annotations.title, 'Missing title');
  assert(typeof tool.annotations.readOnlyHint === 'boolean', 'Missing readOnlyHint');
  assert(typeof tool.annotations.destructiveHint === 'boolean', 'Missing destructiveHint');
  assert(typeof tool.annotations.idempotentHint === 'boolean', 'Missing idempotentHint');
  assert(typeof tool.annotations.openWorldHint === 'boolean', 'Missing openWorldHint');
});

test('pr_summary is readOnly', async (client) => {
  const res = await client.send('tools/list', {});
  const tool = res.result.tools.find(t => t.name === 'pr_summary');
  assert(tool.annotations.readOnlyHint === true, 'pr_summary should be readOnly');
});

test('pr_merge is destructive', async (client) => {
  const res = await client.send('tools/list', {});
  const tool = res.result.tools.find(t => t.name === 'pr_merge');
  assert(tool.annotations.destructiveHint === true, 'pr_merge should be destructive');
});

test('resources/list returns empty array', async (client) => {
  const res = await client.send('resources/list', {});
  assert(Array.isArray(res.result?.resources), 'Expected resources array');
});

test('resources/read with valid URI returns data', async (client) => {
  const res = await client.send('resources/read', { uri: 'pr://thebtf/pr-review-mcp/2' });
  assert(res.result?.contents?.[0]?.uri === 'pr://thebtf/pr-review-mcp/2', 'Wrong URI');
  assert(res.result?.contents?.[0]?.mimeType === 'application/json', 'Wrong mimeType');

  const data = JSON.parse(res.result.contents[0].text);
  assert(data.pr?.number === 2, 'Wrong PR number');
  assert(typeof data.summary?.total === 'number', 'Missing summary.total');
});

test('resources/read with invalid URI returns error', async (client) => {
  const res = await client.send('resources/read', { uri: 'invalid-uri' });
  assert(res.error, 'Expected error for invalid URI');
  assert(res.error.message.includes('Invalid PR resource URI'), 'Wrong error message');
});

test('prompts/list returns review prompt', async (client) => {
  const res = await client.send('prompts/list', {});
  const review = res.result?.prompts?.find(p => p.name === 'review');
  assert(review, 'Missing review prompt');
});

test('server startup logs to stderr', async (client) => {
  const hasStartupLog = client.logs.some(l => l.includes('GitHub token configured'));
  assert(hasStartupLog, 'Missing startup log');
});

test('pr_summary tool call works', async (client) => {
  const res = await client.send('tools/call', {
    name: 'pr_summary',
    arguments: { owner: 'thebtf', repo: 'pr-review-mcp', pr: 2 }
  });
  assert(!res.error, `Tool error: ${res.error?.message}`);
  const data = JSON.parse(res.result.content[0].text);
  assert(typeof data.total === 'number', 'Missing total');
});

// ============================================================================
// RUNNER
// ============================================================================

async function run() {
  console.log('🧪 MCP Feature Tests\n');

  const client = new MCPClient();
  await client.start();

  for (const { name, fn } of TESTS) {
    try {
      await fn(client);
      console.log(`✅ ${name}`);
      passed++;
    } catch (e) {
      console.log(`❌ ${name}: ${e.message}`);
      failed++;
    }
  }

  client.close();

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Passed: ${passed}/${TESTS.length}`);
  console.log(`Failed: ${failed}/${TESTS.length}`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
