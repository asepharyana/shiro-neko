# TODO

Next up. One item, one outcome, verifiable when done.

Longer-term direction lives in [ROADMAP.md](ROADMAP.md).

---

## Now

_Empty — pick from Known rough edges below._

---

## Next

_Empty._

---

## Maintenance

_All caught up._

---

## Known rough edges

Not bugs exactly, but things that will bite someone.

- **`/clear` wipes the terminal scrollback.** `<Static>` output is already committed, so
  clearing React state alone leaves it on screen. The escape sequence works but takes the
  user's earlier terminal history with it.
- **Memory has no conflict resolution.** Two contradictory notes both persist and both get
  injected. `/memory` may merge them, or may keep both.
- **Windows `cmd /c` differs from `bash -lc`.** A command the model writes for one shell may
  fail on the other. The prompt states the platform; it does not translate.
- **Permission rules gate the call, not what it does.** `bash` with `git *` allowed will run a
  `git` alias that shells out to anything, and there is no sandbox around the shell. Codex solves
  this with OS-level isolation — Seatbelt, Landlock, a Windows equivalent — which is three
  platform-specific implementations and not something to half-ship.
- **The reasoning panel is per-turn, not per-step.** Reasoning from an early step stays on
  screen through later ones until the turn ends.
- **An interrupted command's effects are unknown, and the model is told so.** Nothing can know
  how far a half-run migration got.
- **An installed skill is a stranger's words in your system prompt.** The install shows the
  body first and `/skills` records the origin, but nothing re-checks it later: a registry that
  changes a URL's contents affects the next install, not one already on disk.
- **A registry index is trusted for its contents, not its authorship.** There are no
  signatures. `registryUrl` is the whole trust decision.

---

## Done

Kept for one release, then deleted.

### 1.0.0 release batch

- [x] A spend ceiling (`maxSpendUsd`): checked before each turn, refused at 100% naming the
      ceiling, warns once at 80%, headless exits non-zero. Unpriced models are not enforced
- [x] A cheaper subagent model (`subagentModel`): `explore` resolves against it, `review` and
      `worker` keep the parent's, `/cost` splits subagent spend by model id
- [x] Twenty new built-in tools (41 total) in a new `extra` set: line edits, filesystem
      navigation, read-only git extensions, and code/environment reads
- [x] Twenty new bundled skills (29 total) plus the eleven originals deepened; all moved to
      `src/skills-md/*.md` as the Markdown source of truth, embedded at build
- [x] Ten new data-only plugins: safety refusals on by default (force push, pipe-to-shell,
      root, env credential writes) and opt-in workflow plugins (conventional commit,
      tests-first, small diffs, main-branch commits, git config, confirm-delete)
- [x] Custom slash commands from Markdown files, with `$ARGUMENTS`/`$1` and guarded shell
      substitution; a custom command never shadows a built-in
- [x] Auto-loaded external skills, tools, and plugins from `~/.shiro-neko/<kind>` and
      `.shiro/<kind>`, all data, never code; a bad file is reported and skipped
- [x] The welcome interface redesigned into a structured dashboard with a session banner, a
      grouped environment panel, and a meta bar; the input in a two-tone box with a split footer
- [x] The system prompt advanced: a failure-recovery loop, a delegation policy, compaction awareness
- [x] The release workflow's dead `dry_run` input wired: manual dispatch publishes only when
      unchecked, tag pushes always publish

### Post-1.0 — Now / Next / Maintenance (landed)

- [x] Summarize the pruned span — `prune.droppedSpan` + `session.summarizeDiscarded`, injected as `Note (retained from compacted history)`, budgeted 6k excerpt + 3–6 lines, one call per compaction (`test/compact.test.ts`)
- [x] Hot-reload an installed entry — `Session.updateSkills/updatePlugins` + `cli.tsx` hot-reload, `pendingSkills/pendingHost` + `drainPendingHotReload` at turn boundary (`test/hot-reload.test.ts`)
- [x] MCP without the schema tax — `mcp_list` / `mcp_inspect` / `mcp_call` phi meta-tools, prompt names-only, permission `mcp_call` + `bindMcpGuard`, `mcpExpose=phi|direct|auto` (`test/mcp.test.ts`)
- [x] Derive the tool-name lists — `withMeta({ set, mutating })`, `setsFrom(tools)` derives `TOOL_SETS`/`MUTATING_TOOLS`/`DEFAULT_PERMISSIONS` (`test/tool-derive.test.ts`)
- [x] Subagent parallelism — `task` fans out `tasks: TaskSpec[]` via `Promise.all` up to 8 (`test/subagent-parallel.test.ts`)
- [x] Undo a turn — `src/snapshot.ts` per-turn capture cap 100, `/undo` + `/redo` files+messages (`test/undo.test.ts`)
- [x] Pricing source + date — `PRICING_VERIFIED_AT='2026-09-09'` + source URLs, `/cost` shows `pricing verified: 2026-09-09 (est.)`
- [x] `estimateTokens` labelling — heuristic doc + `(est.)` in `/cost` + `~N est. in context`
- [x] `listPaths` stale walk — `fileChangeSeq` on `recordBeforeWrite`/`restoreFiles`, `@` invalidates `paths` on seq change
- [x] `MUTATING_TOOLS` derivation — `BASE_PERMISSIONS` + `buildDefaults()` derives from `MUTATING_TOOLS` via `require('./tools')`
- [x] Unknown `toolSets` silently dropped — `unknownToolSetNames()` + startup notice `unknown toolSets ignored: …` (`test/config-toolsets.test.ts`, `5028ea6`)
- [x] `@` directories — `walk({ includeDirs: true })` yields `src/` with trailing `/`, `matchPaths` ranks dirs before files (`test/complete-dirs.test.ts`, `4b4ddd0`)

### Session-feature batch (7 features)

- [x] `/changes` — diff the last turn's snapshot: added / modified / deleted, per absolute path, no bash effects (`session.lastTurnSummary` + `snapshot.peek`)
- [x] System-prompt memoization — version counters on notebook/memory/skills/plugins/tools/workspace, cached per version key, hit-rate in `/cost` (foundation for provider prompt caching)
- [x] `web_search` — DuckDuckGo Lite, no API key, 5 results with title/URL/snippet, SSRF-filtered through `checkUrl`, in the `net` set
- [x] `/search <query>` — full-text over saved sessions, matches transcript strings and tool-input JSON
- [x] Workspace file list refresh — after a turn that wrote files, re-walk at the boundary so the next prompt shows new paths
- [x] Per-turn spend cap — `maxSpendPerTurn`, aborts a step past the line with a notice
- [x] `/fork` — clone the session at the last turn boundary to a new saved session; original untouched
