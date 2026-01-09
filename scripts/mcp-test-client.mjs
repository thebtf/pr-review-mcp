#!/usr/bin/env node
/**
 * MCP Test Client for PR Review Server
 *
 * Usage:
 *   node scripts/mcp-test-client.mjs                    # Interactive mode
 *   node scripts/mcp-test-client.mjs pr_summary 2       # Quick call: tool + PR number
 *   node scripts/mcp-test-client.mjs pr_list 2 false    # pr_list with resolved=false filter
 *
 * IMPORTANT: MCP uses newline-delimited JSON, NOT Content-Length framing!
 */

import { spawn } from 'child_process';
import * as readline from 'readline';

const OWNER = process.env.MCP_TEST_OWNER || 'thebtf';
const REPO = process.env.MCP_TEST_REPO || 'pr-review-mcp';

class MCPTestClient {
  constructor() {
    this.messageId = 0;
    this.pendingRequests = new Map();
    this.serverProcess = null;
    this.rl = null;
  }

  async start() {
    // Spawn server
    this.serverProcess = spawn('node', ['dist/index.js'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd()
    });

    // Handle server stderr (logs)
    this.serverProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.error(`[server] ${msg}`);
    });

    // Handle server stdout (JSON-RPC responses)
    const rl = readline.createInterface({ input: this.serverProcess.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const response = JSON.parse(line);
        if (typeof response !== 'object' || response === null) {
          console.error('[invalid response]', line);
          return;
        }
        if (!('id' in response)) {
          console.log('[notification]', JSON.stringify(response, null, 2));
          return;
        }
        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          pending.resolve(response);
          this.pendingRequests.delete(response.id);
        }
      } catch (e) {
        console.error('[parse error]', line);
      }
    });

    this.serverProcess.on('close', (code) => {
      console.log(`[server exited with code ${code}]`);
      process.exit(code || 0);
    });

    // Wait for server to start (configurable via env)
    const startupDelay = parseInt(process.env.MCP_STARTUP_DELAY || '500', 10);
    await new Promise(r => setTimeout(r, startupDelay));

    // Initialize
    const initResult = await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-test-client', version: '1.0.0' }
    });
    console.log('[initialized]', initResult.result?.serverInfo?.name || 'OK');

    // Send initialized notification
    this.notify('notifications/initialized', {});

    return this;
  }

  send(method, params = {}) {
    const id = ++this.messageId;
    const message = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });

      // CRITICAL: Newline-delimited JSON, NOT Content-Length framing!
      this.serverProcess.stdin.write(JSON.stringify(message) + '\n');

      // Timeout after 30s
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });
  }

  notify(method, params = {}) {
    const message = { jsonrpc: '2.0', method, params };
    this.serverProcess.stdin.write(JSON.stringify(message) + '\n');
  }

  async callTool(name, args) {
    const response = await this.send('tools/call', { name, arguments: args });
    if (response.error) {
      throw new Error(response.error.message);
    }
    return response.result;
  }

  async listTools() {
    const response = await this.send('tools/list', {});
    return response.result?.tools || [];
  }

  close() {
    if (this.serverProcess) {
      this.serverProcess.kill();
    }
  }
}

// Tool shortcuts
const TOOLS = {
  pr_summary: (pr) => ({ owner: OWNER, repo: REPO, pr: parseInt(pr) }),
  pr_list: (pr, resolved) => ({
    owner: OWNER, repo: REPO, pr: parseInt(pr),
    filter: resolved !== undefined ? { resolved: resolved === 'true' } : undefined
  }),
  pr_get: (pr, id) => ({ owner: OWNER, repo: REPO, pr: parseInt(pr), id }),
  pr_resolve: (pr, threadId) => ({ owner: OWNER, repo: REPO, pr: parseInt(pr), threadId }),
  pr_changes: (pr, cursor) => ({ owner: OWNER, repo: REPO, pr: parseInt(pr), cursor }),
  pr_invoke: (pr, agent) => ({ owner: OWNER, repo: REPO, pr: parseInt(pr), agent: agent || 'all' }),
  pr_poll_updates: (pr, since, includeAgents) => ({
    owner: OWNER, repo: REPO, pr: parseInt(pr),
    since: since && since !== 'null' && since !== 'undefined' ? since : undefined,
    include: includeAgents === 'agents' ? ['agents'] : undefined
  }),
  pr_labels: (pr, action, ...labels) => ({
    owner: OWNER, repo: REPO, pr: parseInt(pr), action, labels
  }),
  pr_reviewers: (pr, action, ...reviewers) => ({
    owner: OWNER, repo: REPO, pr: parseInt(pr), action, reviewers
  }),
  pr_create: (head, title, base) => ({
    owner: OWNER, repo: REPO, title: title || `PR from ${head}`, head, base: base || 'main'
  }),
  pr_merge: (pr, method) => ({
    owner: OWNER, repo: REPO, pr: parseInt(pr), method: method || 'squash', confirm: true
  }),
  pr_review_cycle: (pr, action, mode) => ({
    owner: OWNER, repo: REPO, pr: parseInt(pr), action: action || 'status',
    ...(mode && { mode })
  }),
  pr_claim_work: (agentId, runId, prInfoJson) => {
    const args = { agent_id: agentId };
    if (runId && runId !== 'null') args.run_id = runId;
    if (prInfoJson && prInfoJson !== 'null') {
      try { args.pr_info = JSON.parse(prInfoJson); } catch (e) { console.error(`[error] Invalid JSON for pr_info: ${e.message}`); }
    }
    return args;
  },
  pr_report_progress: (agentId, file, status, resultJson) => {
    const args = { agent_id: agentId, file, status };
    if (resultJson && resultJson !== 'null') {
      try { args.result = JSON.parse(resultJson); } catch (e) { console.error(`[error] Invalid JSON for result: ${e.message}`); }
    }
    return args;
  },
  pr_get_work_status: (runId) => {
    const args = {};
    if (runId && runId !== 'null') args.run_id = runId;
    return args;
  }
};

// Helper to safely extract result text
function extractResultText(result) {
  if (!result?.content?.[0]?.text) {
    throw new Error('Invalid result structure: missing content[0].text');
  }
  try {
    return JSON.parse(result.content[0].text);
  } catch (e) {
    // If not valid JSON, return as-is (handles text responses and errors)
    console.log('[non-JSON response detected, displaying as text]');
    return result.content[0].text;
  }
}

async function interactive(client) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'mcp> '
  });

  console.log('\nCommands:');
  console.log('  tools                    - List available tools');
  console.log('  summary <pr>             - Get PR summary');
  console.log('  list <pr> [resolved]     - List comments (resolved=true/false)');
  console.log('  get <pr> <id>            - Get comment details');
  console.log('  resolve <pr> <threadId>  - Resolve thread');
  console.log('  invoke <pr> [agent]      - Invoke review agent');
  console.log('  raw <method> <json>      - Send raw JSON-RPC');
  console.log('  exit                     - Quit\n');

  rl.prompt();

  rl.on('line', async (line) => {
    const parts = line.trim().split(/\s+/);
    const cmd = parts[0];

    try {
      switch (cmd) {
        case 'tools': {
          const tools = await client.listTools();
          console.log('Available tools:');
          tools.forEach(t => console.log(`  ${t.name} - ${t.description}`));
          break;
        }
        case 'summary': {
          const result = await client.callTool('pr_summary', TOOLS.pr_summary(parts[1] || 2));
          console.log(JSON.stringify(extractResultText(result), null, 2));
          break;
        }
        case 'list': {
          const result = await client.callTool('pr_list', TOOLS.pr_list(parts[1] || 2, parts[2]));
          console.log(JSON.stringify(extractResultText(result), null, 2));
          break;
        }
        case 'get': {
          const result = await client.callTool('pr_get', TOOLS.pr_get(parts[1], parts[2]));
          console.log(JSON.stringify(extractResultText(result), null, 2));
          break;
        }
        case 'resolve': {
          const result = await client.callTool('pr_resolve', TOOLS.pr_resolve(parts[1], parts[2]));
          console.log(JSON.stringify(extractResultText(result), null, 2));
          break;
        }
        case 'invoke': {
          const result = await client.callTool('pr_invoke', TOOLS.pr_invoke(parts[1] || 2, parts[2]));
          console.log(JSON.stringify(extractResultText(result), null, 2));
          break;
        }
        case 'raw': {
          const method = parts[1];
          let params = {};
          const paramsStr = parts.slice(2).join(' ');
          if (paramsStr) {
            try {
              params = JSON.parse(paramsStr);
            } catch (e) {
              console.error('Error: Invalid JSON parameters:', e.message);
              break;
            }
          }
          const result = await client.send(method, params);
          console.log(JSON.stringify(result, null, 2));
          break;
        }
        case 'exit':
        case 'quit':
        case 'q':
          client.close();
          process.exit(0);
          break;
        case '':
          break;
        default:
          console.log(`Unknown command: ${cmd}`);
      }
    } catch (e) {
      console.error('Error:', e.message);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    client.close();
    process.exit(0);
  });
}

async function quickCall(client, tool, args) {
  const toolFn = TOOLS[tool];
  if (!toolFn) {
    console.error(`Unknown tool: ${tool}`);
    console.log('Available:', Object.keys(TOOLS).join(', '));
    process.exit(1);
  }

  // Check minimum required arguments
  const minArgs = {
    pr_summary: 1, pr_list: 1, pr_get: 2, pr_resolve: 2, pr_changes: 1,
    pr_invoke: 1, pr_poll_updates: 1, pr_labels: 3, pr_reviewers: 3,
    pr_create: 1, pr_merge: 1, pr_review_cycle: 1,
    pr_claim_work: 1, pr_report_progress: 3, pr_get_work_status: 0
  };
  const required = minArgs[tool] || 0;
  if (args.length < required) {
    console.error(`Error: ${tool} requires at least ${required} argument(s), got ${args.length}`);
    process.exit(1);
  }

  const toolArgs = toolFn(...args);
  const result = await client.callTool(tool, toolArgs);
  console.log(JSON.stringify(extractResultText(result), null, 2));
  client.close();
}

// Main
const client = new MCPTestClient();
await client.start();

const [,, tool, ...args] = process.argv;

if (tool) {
  await quickCall(client, tool, args);
} else {
  await interactive(client);
}
