# MCP Resources Support

This document describes the MCP Resources capability implemented in pr-review-mcp server.

## Overview

The pr-review-mcp server now supports the MCP Resources specification (2025-11-25), allowing clients to access pull request data as resources using a standardized URI scheme.

## Resource URI Scheme

Resources use the following URI format:

```
pr://{owner}/{repo}/{pr}
```

### Examples

- `pr://thebtf/pr-review-mcp/2` - PR #2 in thebtf/pr-review-mcp
- `pr://facebook/react/12345` - PR #12345 in facebook/react

## Endpoints

### `resources/list`

Lists available resources. Returns a resource template that describes the URI format for accessing PR resources.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "resources/list"
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "resources": [
      {
        "uri": "pr://{owner}/{repo}/{pr}",
        "name": "Pull Request Resource",
        "description": "Dynamic PR resource with summary and metadata. Use pr://{owner}/{repo}/{pr} format.",
        "mimeType": "application/json"
      }
    ]
  }
}
```

### `resources/read`

Reads a PR resource by URI, returning PR metadata and review summary statistics.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "resources/read",
  "params": {
    "uri": "pr://thebtf/pr-review-mcp/2"
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "contents": [
      {
        "uri": "pr://thebtf/pr-review-mcp/2",
        "mimeType": "application/json",
        "text": "{...}"
      }
    ]
  }
}
```

## Resource Content Schema

The resource content is a JSON object with the following structure:

```typescript
{
  pr: {
    owner: string;           // Repository owner
    repo: string;            // Repository name
    number: number;          // Pull request number
    title?: string;          // PR title
    state?: string;          // PR state (OPEN, CLOSED, MERGED)
    isDraft?: boolean;       // Whether PR is a draft
    author?: string;         // PR author username
    branch?: string;         // Head branch name
    baseBranch?: string;     // Base branch name
    mergeable?: string;      // Mergeable status
    reviewDecision?: string; // Review decision (APPROVED, CHANGES_REQUESTED, etc.)
    createdAt?: string;      // ISO timestamp
    updatedAt?: string;      // ISO timestamp
  },
  summary: {
    total: number;           // Total review comments
    resolved: number;        // Resolved comments
    unresolved: number;      // Unresolved comments
    outdated: number;        // Outdated comments
    bySeverity: {            // Comments grouped by severity
      [severity: string]: number;
    },
    byFile: {                // Comments grouped by file
      [file: string]: number;
    },
    nitpicks?: {             // CodeRabbit nitpick statistics
      total: number;
      resolved: number;
      unresolved: number;
    }
  }
}
```

## Error Handling

### Invalid URI Format

If the URI doesn't match the expected format, an error is returned:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "error": {
    "code": -32602,
    "message": "Invalid PR resource URI format. Expected: pr://{owner}/{repo}/{pr}"
  }
}
```

### PR Not Found

If the PR doesn't exist or is inaccessible:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "error": {
    "code": -32603,
    "message": "Resource not found"
  }
}
```

### Authentication Error

If the GitHub token is missing or invalid:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "error": {
    "code": -32603,
    "message": "Authentication failed"
  }
}
```

## Implementation Details

### Files

- **`src/resources/pr.ts`** - Core resource logic for listing and reading PR resources
- **`src/server.ts`** - Resource handler registration and routing

### Dependencies

The resource implementation reuses existing tools:
- `prSummary` - Fetches review comment statistics
- `QUERIES.getPullRequest` - Direct GraphQL query to fetch PR metadata (title, state, author, etc.)

### Data Flow

1. Client sends `resources/read` request with PR URI
2. Server parses URI to extract owner, repo, and PR number
3. Server fetches PR summary and metadata in parallel using existing tools
4. Server combines data into resource content format
5. Server returns JSON response with `application/json` MIME type

## Usage Example

```javascript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const client = new Client({
  name: 'example-client',
  version: '1.0.0'
});

// Connect to server
await client.connect(transport);

// Read PR resource
const result = await client.request({
  method: 'resources/read',
  params: {
    uri: 'pr://thebtf/pr-review-mcp/2'
  }
});

const content = JSON.parse(result.contents[0].text);
console.log(`PR #${content.pr.number}: ${content.pr.title}`);
console.log(`Total comments: ${content.summary.total}`);
console.log(`Unresolved: ${content.summary.unresolved}`);
```

## Future Enhancements

Potential improvements for future versions:

1. **Dynamic Resource Listing** - List all PRs in a repository via `resources/list`
2. **Resource Templates** - Support URI templates like `pr://{owner}/{repo}/{pr}/comments`
3. **Resource Subscriptions** - Notify clients when PR resource content changes
4. **File-level Resources** - Access individual files within a PR as sub-resources
5. **Comment Resources** - Access individual comments as resources
