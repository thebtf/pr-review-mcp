# PR Review Skills

Example Claude Code skills for PR review automation.

## Structure

```
skills/
├── pr-review/           # Main autonomous review skill
│   └── SKILL.md
├── pr-review-orchestrator/  # Parallel coordination
│   └── SKILL.md
└── pr-review-worker/    # File partition processor
    └── SKILL.md
```

## Usage

Copy desired skill folder to your project's `.claude/skills/` directory.

## Skills

| Skill | Purpose |
|-------|---------|
| `pr-review` | Autonomous multi-agent PR review until all comments resolved |
| `pr-review-orchestrator` | Coordinate parallel workers for large PRs |
| `pr-review-worker` | Process claimed file partitions |
