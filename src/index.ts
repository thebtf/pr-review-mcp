#!/usr/bin/env node
/**
 * PR Review MCP Server Entry Point
 *
 * GraphQL-based PR review processing with:
 * - Cursor pagination (zero comments missed)
 * - 4-layer AI prompt extraction
 * - Circuit breaker + rate limiting
 * - Automated workflow prompt
 *
 * Transport modes:
 * - stdio (default): for CLI integrations (Claude Code, MCP Inspector)
 * - --http [port]: StreamableHTTP server on specified port (default: 3000)
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const arg = process.argv[2];
if (arg === '--version' || arg === '-v' || arg === '-V') {
  console.log(`pr-review-mcp v${pkg.version}`);
  process.exit(0);
}

// Parse transport mode
let mode: 'stdio' | 'http' = 'stdio';
let httpPort = 3000;

if (arg === '--http') {
  mode = 'http';
  const portArg = process.argv[3];
  if (portArg && /^\d+$/.test(portArg)) {
    httpPort = parseInt(portArg, 10);
  }
}

const { PRReviewMCPServer } = await import('./server.js');

const server = new PRReviewMCPServer();
server.run({ mode, port: httpPort }).catch(console.error);
