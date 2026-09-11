# Background bash — run long-lived commands without blocking the turn

Status: spec (implemented)
Date: 2026-09-11

## Problem

Running a dev server (or any long-lived command) via `bash` blocks the tool
until the process exits or the 120 s default timeout fires. A dev server never
exits, so the model burns the turn waiting, then gets a killed-by-timeout error
in which the server may or may not still be running. Dev workflows inside the
agent are effectively impossible.

## Design

Add an optional `background: true` mode to `bash`. Background commands:

- spawn detached (new process group / session) so the agent process can exit
  without taking them down, and so ctrl-c in the agent never kills them.
- return immediately with a `handle` (small integer), a `started` marker, and
  the first few lines of output (when available).
- keep streaming output into a per-handle ring buffer (capped) in memory;
  `bash_status` returns recent output and the current running/finished state.
- are reaped on agent shutdown — the module saves a `~/.shiro-neko/backgrounds.json`
  journal and kills live children on exit (kill `Bun.spawn` process).
- can be killed explicitly via `bash_stop` (the tool), or ctrl-c while focused,
  or `/bash` (the command).

### Why a handle + tools, not a long-lived "bash" result

Background processes are by definition not one-shot, so a single tool result
cannot represent them. Separating into `bash` (start/one-shot) + `bash_status`
(poll) + `bash_stop` (kill) keeps each tool's contract small and lets the agent
poll while continuing to work. The model is instructed to poll and stop when
done; otherwise the process lingers until shutdown reaps it.

### Why detached

`Bun.spawn(..., {detached: true})` (a.k.a. setsid) is required so that:
- killing the agent does not SIGKILL the dev server (kill process-group on exit
  is deliberate, see below);
- ctrl-c in the agent (which kills the agent's own process group) does not
  signal the dev server;
- `interruptBash()` keeps working for foreground commands only.

On Windows, process groups work differently (`detached` behaves differently in
Bun; the kill is best-effort). Document that background is primarily for
Unix-like dev servers.

## Tool changes

### `bash` — add `background?: boolean` and `name?: string`

- `background` default false (foreground = existing behavior, backward compat).
- `name` optional label used for /bash listing.
- When background:
  - spawn `bash -lc '<cmd>'` with `detached: true` (or `cmd /c` + best-effort on
    win32), pipes captured for streaming, no tool timeout (the process decides
    its own lifetime).
  - register in the module-level `backgrounds` map keyed by an incrementing
    handle.
  - return `running <handle>: <cmd> (background pid N)` — the model learns the
    handle and can poll.
- The `running` map (foreground, `interruptBash`) is untouched: foreground
  commands still behave exactly as today.

### `bash_status` — new `nav`/`core` read tool

- Input: `handle: number`.
- Output: one of:
  - `running`: `status: running (pid N)\n<recent output, tail capped>`
  - `finished`: `status: finished, exit: <code>\n<tail of captured output>`
  - `not found`: `status: no such handle`
- Implementation reuses `bashListener` streaming (sessions get live progress
  while a background command runs) and keeps a tail buffer per handle
  (`MAX_OUTPUT`-capped, so the model never burns context).

### `bash_stop` — new mutating tool

- Input: `handle: number`.
- Returns which command was killed (`killed <handle>: <cmd>`), or
  `no such handle` when absent. Reuses `killTree` (process-group aware) on the
  background process, awaited so the process really is gone.

### Tool registrations

- `bash_status`: `withMeta({ set: 'core', mutating: false })`, read tool, no
  approval needed (like `read_file`).
- `bash_stop`: `withMeta({ set: 'core', mutating: true })` — mutating requires
  a `DEFAULT_PERMISSIONS` entry + `subjectOf` case in `src/permission.ts`
  (falls back to `ask` on `*` otherwise, bypassing command gating).
- `bash` remains `mutating: true`; `bash_stop` and `bash` share the bash
  permission subject (`bash` subjectOf: `bash_stop` command = `bash <cmd>`),
  so an approved `bash` rule can also cover `bash_stop` (subject-derived).
- `MUTATING_TOOLS`/`TOOL_SETS` derive automatically via `_meta`.

### Default permissions

- `bash_stop` added to the mutating loop list (`src/permission.ts:223`).
- `subjectOf` (`src/permission.ts:306`) maps `bash_stop` → `'bash'` so existing
  bash rules apply (e.g. a blanket allow on `bash` covers stop).

## Session / UI

- `src/session.ts` streams background command output through the existing
  `onBashOutput` listener (live output panel in interactive mode, same as a
  foreground command's streaming).
- `src/ui/App.tsx`: render the `[bg N]` prefix from the `bash` tool result and
  make ctrl-c while no foreground command is running stop the most recently
  started background command (mirror of `interruptBash`). Keeps esc semantics:
  with a foreground command running, esc still kills it first.
- `src/commands.ts`: `/bash` command — `list` (default) shows
  `handle: cmd (running|exit N)`, `stop <id>` kills, `stop all` kills all.
  Parser case in `commands.ts`, UI switch in `App.tsx`.
- `src/cli.tsx` shutdown: before `process.exit`, call
  `shutdownBackgrounds()` (async kill live children + write journal).
  Best-effort — must not throw or delay exit. Journal written to
  `~/.shiro-neko/backgrounds.json` (SHIRO_HOME-aware via `store.ts` patterns).

### Prompt guidance

- `src/prompt.ts` bash tool descriptions: note that long-lived commands
  (dev servers, watchers, tests that run forever, `bun dev`) should use
  `background: true` and then be polled with `bash_status` and stopped with
  `bash_stop` when done. Instruct the model to always stop what it starts.

## Files touched

- `src/tools.ts` — bash background branch, `bash_status`, `bash_stop`,
  registry entries, `bgHandle` counter, `backgrounds` map, `killBackground`.
- `src/tool-utils.ts` — no change (meta derives).
- `src/permission.ts` — mutating list + `subjectOf` + DEFAULT_PERMISSIONS.
- `src/prompt.ts` — tool descriptions / guidance (bash description + status/stop).
- `src/session.ts` — listener wiring (streaming bg output) if not already
  covered by `onBashOutput`; nothing else needed.
- `src/commands.ts` — `/bash` command definition + parser case.
- `src/ui/App.tsx` — `/bash` switch case + ctrl-c background fallback.
- `src/cli.tsx` — shutdown reaping + journal.
- `test/tools.test.ts` — bg tests.
- `test/permission.test.ts` — auto (bash_stop mutating coverage).
- `test/commands.test.ts` — `/bash` parse + list/stop.

## Verification

- `bun test` (665+ tests, new ones included: `sleep 30` background returns
  immediately; status shows running then finished after `exit 0`; stop kills;
  journal + reap on shutdown; `/bash list/stop` parse).
- `bun run typecheck`.
- `bun run build` (must pass `--production`; `dist/shiro --version`).
- Manual: `SHIRO_HOME=$(mktemp -d) bun run src/cli.tsx -p "run a dev server in
  the background and check it is up, then stop it" --yolo --json`.

## Risks / notes

- Old journal entries (from crashed sessions) are reaped on next boot: at
  startup, kill stale PIDs or ignore missing ones. Do not leak orphan dev
  servers across sessions.
- `bash_status` poll output is capped (context safety).
- Windows: background is best-effort (no process group / setsid semantics);
  foreground behavior unchanged.
- Background processes are not snapshot / undo targets; killing on shutdown
  is deliberate to avoid orphan servers the user cannot see.