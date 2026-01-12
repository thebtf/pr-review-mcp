/**
 * MCP Logging Utility
 *
 * Provides logging functionality using MCP protocol logging messages
 * per MCP 2025-11-25 specification.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

/**
 * Logger instance that wraps MCP server logging
 */
export class MCPLogger {
  private server: Server | null = null;
  private readonly loggerName: string;

  constructor(loggerName: string = 'pr-review-mcp') {
    this.loggerName = loggerName;
  }

  /**
   * Initialize logger with MCP server instance
   * Must be called after server is created
   */
  initialize(server: Server): void {
    this.server = server;
  }

  /**
   * Log a message at the specified level
   */
  log(level: LogLevel, message: string, data?: unknown): void {
    if (!this.server) {
      // Fallback to stderr if server not initialized (startup errors)
      console.error(`[${level.toUpperCase()}] ${message}`, data !== undefined ? data : '');
      return;
    }

    try {
      this.server.sendLoggingMessage({
        level,
        logger: this.loggerName,
        data: data !== undefined ? `${message}: ${JSON.stringify(data)}` : message
      });
    } catch (error) {
      // Fallback to stderr if MCP logging fails
      console.error(`[MCP LOG FAIL] [${level.toUpperCase()}] ${message}`, data !== undefined ? data : '');
      if (error instanceof Error) {
        console.error(`[MCP LOG FAIL] Reason: ${error.message}`);
      }
    }
  }

  /**
   * Log debug message
   */
  debug(message: string, data?: unknown): void {
    this.log('debug', message, data);
  }

  /**
   * Log info message
   */
  info(message: string, data?: unknown): void {
    this.log('info', message, data);
  }

  /**
   * Log warning message
   */
  warning(message: string, data?: unknown): void {
    this.log('warning', message, data);
  }

  /**
   * Log error message
   */
  error(message: string, data?: unknown): void {
    this.log('error', message, data);
  }
}

/**
 * Global logger instance
 */
export const logger = new MCPLogger('pr-review-mcp');
