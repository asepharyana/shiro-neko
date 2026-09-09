# Project-driven agent workflow

Shiro Neko treats a repository the way this project treats itself: progress
tracked in TODO.md and ROADMAP.md, docs-driven development, spec-first plans,
complete unit tests, and verify-before-done. When the repo keeps those files,
the agent's system prompt carries a short workflow policy and the session
tracks whether the workflow is being followed.

## What the agent sees

When the session starts in a git repo that has any of:

- `TODO.md` at the git root
- `ROADMAP.md` at the git root
- a `docs/` directory (configurable with `workflow.docsDir`)

the system prompt gains a "Project workflow" block:

- read TODO.md (the task list) before starting and keep it current as you go
- keep ROADMAP.md current when a milestone ships
- write a short plan first (spec-first) for anything non-trivial
- add tests alongside code; the project expects complete unit tests
- verify with the project's check commands (tests/typecheck/build) before
  declaring done

Bare repos (no TODO, ROADMAP, or docs) get no such block — the policy only
renders when the project itself tracks progress, so a throwaway directory does
not collect noise.

TODO.md and ROADMAP.md are also loaded into the conversation like instruction
files (`Project tracker (...)`), capped tighter than AGENTS.md so the agent
sees the shape of the work without filling its context. This mirrors the
existing `AGENTS.md` / `CLAUDE.md` / `.shiro.md` loading: outermost first, git
root down to cwd.

## The nudge

After a turn that wrote files (edit_file, write_file, apply_patch, ...) but
never called `todo_write`, the session emits one soft notice:

```
reminder: you modified files without updating the project task list (TODO.md).
Keep it current: mark what you did.
```

Design constraints:

- **Once per session.** Repeating a nag trains the model to ignore it.
- **Not a gate.** The agent stays in control; this is guidance, not a block.
- **Only when the repo has a TODO/ROADMAP.** A repo that tracks nothing gets
  no reminder.
- Suppressed when the turn already called `todo_write` — the task list is
  current, nothing to say.

## Configuration

```yaml
workflow:
  enabled: true   # master switch; default true
  docsDir: docs   # where the project keeps developer docs; default 'docs'
```

`workflow.enabled: false` disables both the prompt policy and the nudge.

## /workflow

`/workflow` renders a panel with the project's tracking state and the
session's behaviour:

| row | meaning |
|---|---|
| `workflow` | on/off from config |
| `TODO.md` | present? line count |
| `ROADMAP.md` | present? line count |
| `docs dir` | present? file count (bounded at 200) |
| `reminders sent` | whether this session nudged (once, ever) |

## Relationship to AGENTS.md

AGENTS.md-style files are standing orders from the user and override the
agent's defaults. The workflow policy is a default that documents what a
repo tracking its own progress expects. When the two conflict, AGENTS.md
wins — the workflow feature is a floor, not a ceiling.