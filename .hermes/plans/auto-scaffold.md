# Auto-scaffold project workflow files on first use in an existing repo

## Problem
`/init` already scaffolds TODO.md / ROADMAP.md / docs/ **manually** (plus writes AGENTS.md
via the model). But when the user runs shiro against an *existing* project that has no
tracking files, nothing is generated automatically — the workflow policy block stays out of
the system prompt, no nudges ever fire, and the model has no task list context.

The user's ask: when the agent starts working in an existing repo that lacks
TODO.md / ROADMAP.md / docs/, generate them (also auto-write AGENTS.md), so the workflow
hooks in before the first turn.

## Scope
- Auto-generate TODO.md, ROADMAP.md, docs/, and AGENTS.md in an existing repo that has none
  of them, before the first user turn.
- Model-driven content (the `/init` prompt pattern) rather than empty templates, so the
  files reflect the actual project.
- Opt-out: `workflow.autoScaffold: false` disables; `workflow.enabled: false` stays the master
  switch. Also bail if the repo already tracks anything (TODO/ROADMAP/docs or AGENTS.md) — a
  repo that self-tracks does not need re-scaffolding.
- Generated files are surfaced as a `notice` event so the CLI/UI can show them.
- No overwriting: never touch an existing file.

## Files touched
- `src/scaffold.ts` — add `scaffoldMissingAuto(cwd, model)` that (a) checks git root,
  (b) if no TODO/ROADMAP/docs/AGENTS.md exist, generates them via one model call
  (reuse `INIT_PROMPT`-style tone, but cover all four files), writing directly.
- `src/session.ts` — in `send()` (first turn only, `workflow.autoScaffold !== false` and
  `workflow.enabled !== false`), call `scaffoldMissingAuto` once; if anything was written,
  set a flag so `systemFor()`'s `workflowPolicy()` sees the files right away, bump
  `versions.workflow`, and yield a `notice`.
- `src/config.ts` — parse `workflow.autoScaffold` from config.
- `src/session.ts` `SessionOptions.workflow` — add `autoScaffold?: boolean` (default true).
- `test/scaffold.test.ts` (new or extend) — auto-scaffold on a repo with nothing; bail when
  TODO.md exists; bail when AGENTS.md exists; opt-out flag.
- `docs/workflow.md` — document auto-scaffold + the flag.

## Verification
- `bun run typecheck` clean.
- `bun test` full suite green.
- New tests cover: auto-scaffold writes 4 files in a bare repo; existing TODO.md bails;
  existing AGENTS.md bails; `autoScaffold:false` skips; notice event emitted.
- `bun run build` compiles.

## Risks / decisions
- One model call for all four files keeps it cheap and atomic-ish; content is project-specific.
- Runs once per session (flag), at first `send()` *before* the model's real turn, so the
  system prompt and the turn see it. If the model call fails, degrade to the existing
  `scaffoldWorkflowFiles` empty-template fallback — never fail the turn.
- Cwd-relative writes: resolve against the **git root**, not `process.cwd()` (matches
  `workflowPolicy`). Nested-cwd runs still write at the repo root.