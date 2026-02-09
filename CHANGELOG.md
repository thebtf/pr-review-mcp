# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] - 2026-02-09

### Added

- **Branch protection guard** — refuse to process a different PR when on a feature branch with an open PR (prevents merge conflicts in worktree setups)
- `branchMismatch` detection in `buildContext()` with clear refusal message and recovery options
- `sameRepo` guard — branch protection only applies within the same repository (cross-repo is safe)
- `sanitizePromptValue()` for branch names in prompts (prompt injection defense)
- 8 unit tests for branch protection scenarios (mismatch/allow/bypass/fail-open)

### Changed

- `buildContext()` restructured: branch detection runs **before** explicit PR processing
- `prListPRs` result cached to avoid duplicate API call in multi-PR fallback

## [0.1.3] - 2026-02-09

### Added

- **Hybrid Task UI monitoring** — orchestrator creates Claude Code Tasks for file partitions and orchestrator steps, providing real-time progress visibility
- **Cross-repo Task subject format** `PR {owner}/{repo}#{pr}: {file}` for multi-repo clarity

### Fixed

- Workers cannot use TaskCreate/TaskUpdate/TaskList (platform limitation for background subagents) — orchestrator now owns all Task UI updates

### Security

- Sanitize GitHub file paths in Task subjects and worker prompts (prompt injection defense)

### Documentation

- Task-first coordination design plan
- Rejected structured output monitoring design

## [0.1.2] - 2026-02-08

### Fixed

- Deduplicate synthetic CodeRabbit nitpick comments (#12)

### Added

- Compact mode for `pr_poll_updates` (#11)
- `--version` / `-v` / `-V` flag to CLI

### CI

- Switch to OIDC trusted publishing for npm

## [0.1.1] - 2026-02-07

### Added

- **`pr_setup` MCP Prompt** — onboarding prompt for configuring `.github/pr-review.json`
  - Reads existing repo config via GitHub API
  - Shows available agents, env config, and configuration priority
  - Guides user through agent selection and config creation

### Improved

- `pr_invoke` tool description now lists available agents inline
- `pr_get_work_status` detects pending AI reviewers (`pendingAgents` field)
- PR review skill: MCP bootstrap step, two-phase re-review polling, `gh` CLI prohibition

### Fixed

- CI: added npm-publish environment and OIDC trusted publishing to GitHub Actions workflow

## [0.1.0] - 2026-01-13

### Added

- **15 MCP Tools** for complete PR review automation
  - `pr_summary` - PR statistics (total, resolved, by severity/file)
  - `pr_list` - List comments with filtering
  - `pr_list_prs` - List open PRs with activity stats
  - `pr_get` - Get comment details with AI prompt extraction
  - `pr_resolve` - Mark thread as resolved via GraphQL
  - `pr_changes` - Incremental updates with cursor pagination
  - `pr_invoke` - Invoke AI reviewers (CodeRabbit, Gemini, Codex, Sourcery, Qodo)
  - `pr_poll_updates` - Poll for new comments and agent status
  - `pr_labels` - Manage PR labels
  - `pr_reviewers` - Manage PR reviewers
  - `pr_create` - Create new PR
  - `pr_merge` - Merge PR with safety checks
  - `pr_claim_work` - Multi-agent work distribution
  - `pr_report_progress` - Worker progress reporting
  - `pr_get_work_status` - Orchestration status

- **Multi-Agent Support**
  - CodeRabbit (`coderabbitai[bot]`)
  - Gemini (`gemini-code-assist[bot]`)
  - Copilot (`copilot-pull-request-reviewer[bot]`)
  - Sourcery (`sourcery-ai[bot]`)
  - Qodo (`qodo-code-review[bot]`)
  - Codex (`chatgpt-codex-connector[bot]`)

- **Smart Parsing**
  - CodeRabbit nitpick extraction from review bodies
  - Multi-issue comment splitting
  - AI prompt extraction with confidence levels
  - Severity classification (CRIT/MAJOR/MINOR)

- **Multi-Agent Orchestration**
  - Parallel worker coordination
  - File-based work partitioning
  - Progress tracking and reporting
  - GitHub comment-based state persistence

- **MCP 2025-11-25 Compliance**
  - Resource support (`pr://` URIs)
  - Structured logging
  - Tool annotations (readOnlyHint, destructiveHint)

- **Resilience**
  - Circuit breaker pattern for API stability
  - Rate limit handling via @octokit plugins
  - Cursor-based pagination for large PRs

[0.1.3]: https://github.com/thebtf/pr-review-mcp/releases/tag/v0.1.3
[0.1.2]: https://github.com/thebtf/pr-review-mcp/releases/tag/v0.1.2
[0.1.1]: https://github.com/thebtf/pr-review-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/thebtf/pr-review-mcp/releases/tag/v0.1.0
