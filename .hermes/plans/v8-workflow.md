# Project-Driven Agent Workflow

Status: spec
Date: 2026-09-09

## Why

The user wants shiro-neko agents to produce the same quality as this repo
itself: docs-driven development, TODO.md + ROADMAP.md lifecycle, spec-first
plans, complete unit tests, verify-before-done. Today the agent only reads
AGENTS.md/CLAUDE.md/.shiro.md; it has no visibility of the project's task
tracking, roadmap, or docs conventions, and nothing reminds it to keep them
current.

## Scope

- Prompt-level workflow policy (rendered in system prompt when enabled)
- Boot loading of TODO.md + ROADMAP.md (compact, capped)
- Lifecycle nudge: after a turn that wrote files without touching the task
  list, emit a soft reminder
- `/workflow` command: show project workflow state
- Config: `workflow.enabled` (default true), `workflow.docsDir` (default `docs/`)
- Docs: docs/workflow.md + ROADMAP/TODO entries
- Tests: prompt rendering, boot load, lifecycle nudge, config merge, /workflow

## Out of scope (explicitly not doing)

- New tools (no permission surface, no storage)
- Blocking / hard gates (agent stays in control; nudges only)
- Auto-updating TODO.md (the agent does it via existing write tools)
- Skill/plugin autoloading (existing system stays)

## Files touched

- src/config.ts — `workflow?: { enabled?: boolean; docsDir?: string }` + merge arm
- src/prompt.ts — WorkflowPolicy block in renderPrompt; depends on config
- src/instructions.ts — load TODO.md + ROADMAP.md from git root; format compact
- src/session.ts — SessionOptions.workflow config; after-turn nudge when
  fileChangeSeq bumped && no todo_write this turn
- src/commands.ts — `/workflow` command (status summary)
- src/cli.tsx — pass config; register /workflow
- src/ui/App.tsx + panel-bodies.ts — /workflow panel
- docs/workflow.md — new; ROADMAP.md, TODO.md updated
- test/workflow.test.ts — new

## Design

### Config (config.ts)

```ts
export type WorkflowConfig = {
  enabled?: boolean;   // default true
  docsDir?: string;    // default 'docs'
};
```

Merged in config.merge (same pattern as maxSpendPerTurn).

### Prompt block (prompt.ts)

Rendered only when workflow.enabled !== false, and only when the project has
TODO.md/ROADMAP.md/docs/ (so a bare repo gets no noise). Wording:

```
Project workflow (this repo tracks its own progress). When the project has a
TODO.md, read it before starting work and keep it current as you go:
- mark done what you finished, and the sub-task you are on
- add tests alongside code; the project expects complete unit tests
- update ROADMAP.md when you ship a milestone
- for anything non-trivial, write a short plan (spec-first) before code
- verify with the project's check commands before declaring done
```

Keyed in promptCache versions as `wf` so toggling the flag re-renders.

### Boot load (instructions.ts)

`loadInstructions` also collects `<gitroot>/TODO.md` and `<gitroot>/ROADMAP.md`
when present, capped (e.g. 6_000 chars each), rendered as:

```
--- TODO.md (project task list) ---
<first N lines, preserving section headers>
```

Rendered AFTER instructions, BEFORE notebook/memory. So the agent always knows
what the project is tracking before it starts.

### Lifecycle nudge (session.ts)

After a turn's stream finishes (where fileChangeSeq is known): if
`workflow.enabled !== false` AND the turn wrote files (fileChangeSeq bumped)
AND the turn did NOT call todo_write AND the project has a TODO.md at the git
root AND this is not the 1st turn (avoid nudge at boot): emit one `info` line
via the normal notice mechanism:

```
reminder: you modified files without updating the project task list (TODO.md).
Keep it current: mark what you did.
```

This is one soft line, not a stop; the run continues normally. Tracked as
`workflowNudged` so it fires at most once per run (and once per session).

### `/workflow` command

Status summary rendered in a panel:
- workflow.enabled from config
- TODO.md present? yes/no + line count
- ROADMAP.md present? yes/no + line count
- docsDir exists? yes/no
- docs/ file count
- tests: count of *.test.ts / *.test.tsx in tree (bounded)
- nudged count this session

### Tests (test/workflow.test.ts)

1. config merge: workflow.enabled + docsDir survive loadConfig merge
2. prompt: workflow policy rendered when enabled + TODO present; absent when
   disabled or bare repo
3. instructions: TODO.md + ROADMAP.md loaded from git root, capped
4. lifecycle nudge: turn writes file, no todo_write -> info message once
5. no nudge when todo_write was called
6. /workflow command parses + panel renders

## Verification

- bun run typecheck
- bun test test/workflow.test.ts test/config.test.ts test/commands.test.ts
- full bun test (background)
- bun run build