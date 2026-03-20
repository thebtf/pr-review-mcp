---
name: setup
description: Configure AI review agents for a repository. Creates .github/pr-review.json.
arguments:
  - name: repo
    description: "Repository in owner/repo format. Omit to infer from git remote."
    required: false
---

# PR Review Setup

Use the `setup` prompt from the `pr` MCP server to configure which AI review agents are active for a repository.

## Steps

1. Call the `setup` prompt from the `pr` MCP server
2. Follow the guided onboarding to select agents and configure defaults
3. The result is a `.github/pr-review.json` file committed to the repository

## Usage

```
/pr:setup              — Setup for current repo
/pr:setup owner/repo   — Setup for specific repo
```
