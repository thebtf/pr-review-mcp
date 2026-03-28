# Contributing

Thank you for contributing to `pr-review-mcp`.

## Prerequisites

- Node.js `>=18.0.0`
- npm
- A GitHub Personal Access Token with `repo` scope if you need to exercise live GitHub integration

## Local setup

```bash
git clone https://github.com/thebtf/pr-review-mcp.git
cd pr-review-mcp
npm install
npm run build
```

## Validation

Run the project checks before opening a pull request:

```bash
npm test
npm run test:coverage
```

If you change MCP behavior, validate it through the MCP server boundary rather than direct function calls. The repository also includes MCP client assets in `.claude-plugin/` and `.mcp.json` for local integration testing.

## Pull requests

- Keep changes focused and documented.
- Update `README.md`, `README.ru.md`, or `CHANGELOG.md` when behavior or user-facing workflows change.
- Prefer tests for new behavior, especially for tool inputs, orchestration flows, and parsing logic.
- Use the repository's commit format: `<type>: <description>`.

## Reporting issues

Open a GitHub issue if you find a defect, unsupported review source pattern, or documentation mismatch.
