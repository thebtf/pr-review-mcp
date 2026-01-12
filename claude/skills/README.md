# PR Review Skills

Example Claude Code skills for PR review automation.

## Structure

```
skills/
├── pr-review/           # Main orchestrator skill (spawns workers)
│   └── SKILL.md
└── pr-review-worker/    # Internal worker (spawned by orchestrator)
    └── SKILL.md
```

## Usage

Copy `pr-review/` folder to your project's `.claude/skills/` directory.

**Note:** `pr-review-worker` is an internal skill spawned automatically by the orchestrator.
It should NOT be invoked directly by users.

## Skills

| Skill | Purpose | User-invocable |
|-------|---------|----------------|
| `pr-review` | Autonomous multi-agent PR review orchestrator | Yes |
| `pr-review-worker` | Process claimed file partitions | No (internal) |

## Quick Start

```
Review PR #100
Process AI review comments for current PR
```
