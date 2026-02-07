#!/usr/bin/env node
/**
 * PR Review MCP Server Entry Point
 *
 * GraphQL-based PR review processing with:
 * - Cursor pagination (zero comments missed)
 * - 4-layer AI prompt extraction
 * - Circuit breaker + rate limiting
 * - Automated workflow prompt
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const arg = process.argv[2];
if (arg === '--version' || arg === '-v' || arg === '-V') {
  console.log(`pr-review-mcp v${pkg.version}`);
  process.exit(0);
}

const { PRReviewMCPServer } = await import('./server.js');

const server = new PRReviewMCPServer();
server.run().catch(console.error);
