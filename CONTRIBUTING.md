# Contributing to pr-review-mcp

## Development Setup

```bash
# Clone repository
git clone https://github.com/thebtf/pr-review-mcp.git
cd pr-review-mcp

# Install dependencies
npm install

# Build
npm run build

# Development mode (watch)
npm run dev
```

## Prerequisites

- Node.js 18+
- GitHub CLI (`gh`) installed and authenticated
- TypeScript knowledge

## Project Structure

```
src/
├── index.ts          # Entry point
├── server.ts         # MCP server + workflow prompt
├── github/
│   ├── client.ts     # GraphQL client with circuit breaker
│   ├── queries.ts    # GraphQL queries
│   └── types.ts      # TypeScript types
├── extractors/
│   ├── prompt.ts     # 4-layer AI prompt extraction
│   └── severity.ts   # Severity detection
└── tools/
    ├── summary.ts    # pr_summary tool
    ├── list.ts       # pr_list tool
    ├── get.ts        # pr_get tool
    ├── resolve.ts    # pr_resolve tool
    ├── changes.ts    # pr_changes tool
    └── shared.ts     # Shared utilities
```

## Testing

```bash
# Run tests
npm test

# Test with a real PR
node test-tools.mjs owner/repo pr_number
```

## Commit Convention

Use conventional commits:
- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation
- `refactor:` Code refactoring
- `test:` Tests

## Pull Request Process

1. Create feature branch from `main`
2. Make changes
3. Run `npm run build` to verify
4. Create PR
5. Address CodeRabbit feedback
6. Merge after approval
