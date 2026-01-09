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

import { PRReviewMCPServer } from './server.js';

const server = new PRReviewMCPServer();
server.run().catch(console.error);
