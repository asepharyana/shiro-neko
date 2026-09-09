# TODO

Next up. One item, one outcome, verifiable when done.

Longer-term direction lives in [ROADMAP.md](ROADMAP.md).

---

## Now

### Summarize the pruned span

Compaction now keeps the model's memory of a turn, but it still tells the model nothing about
the messages it dropped, so a decision from forty messages ago can be contradicted with
confidence.

- [x] Summarize the discarded messages before dropping them (`prune.droppedSpan` + `session.summarizeDiscarded`)
- [x] Inject the summary in place of the count (`Note (retained from compacted history)` appended to history)
- [x] Budget it: a summary that grows with the session defeats the point (6k excerpt + 3-6 lines, one call per compaction)
- [x] Test: a pruned decision is still recoverable from the summary (`test/compact.test.ts` lossless suite)

### Hot-reload an installed entry

`/registry add` writes the file and says to restart. The skill catalogue and the guard chain
are both assembled at boot, so a mid-session install does nothing until then.

- [x] Rebuild the skill list and plugin host after an install or removal (`Session.updateSkills/updatePlugins` + `cli.tsx` hot-reload)
- [x] Leave a turn in flight alone: its rules must not change underneath it (`pendingSkills/pendingHost` + `drainPendingHotReload` at turn boundary)
- [x] Test: a skill installed mid-session is callable in the next turn without a restart (`test/hot-reload.test.ts`)

---

## Next

### MCP without the schema tax

Every MCP tool's schema goes into the prompt today, so twenty tools from one server cost roughly
2,750 tokens per request whether the model uses them or not. `toolSets` does not gate them.

phi solves this with three meta-tools — `mcp_list`, `mcp_inspect`, `mcp_call` — and a prompt that
names only the servers. A hundred servers then cost almost nothing until one is called.

- [x] `mcp_list` / `mcp_inspect` / `mcp_call` replacing per-tool registration (`src/mcp.ts`: phi meta-tools, lazy list/inspect/call, `mcpExpose=phi`)
- [x] The prompt lists server names, not schemas (`src/prompt.ts`: `mcpServers` names-only, direct schemas omitted under phi)
- [x] Calls go through the same permission rules and guard as a built-in (`permission mcp_call` + `bindMcpGuard`, intra-turn suppressed, ask-to-approve otherwise)
- [x] Keep per-tool registration as an option: a two-tool server is cheaper registered directly (`mcpExpose=direct` / `mcpExpose=auto`)
- [x] Test: a configured server contributes no schema to the request until `mcp_call` (`test/mcp.test.ts` phi vs direct)

### Derive the tool-name lists

`TOOL_SETS` and `MUTATING_TOOLS` both list names by hand. A tool added to one and forgotten
in the other is a silently ungated write, which is the worst kind of bug this codebase can
have.

- [x] Mark each tool as mutating where it is defined, not in a list beside it (`src/tool-utils.ts` `withMeta({ set, mutating })`, each tool file wraps its `tool({` definitions — 41 tools across `tools.ts`/`tools-extra.ts`/`tools-git.ts`/`tools-net.ts`)
- [x] `TOOL_SETS` covers every registered tool, checked rather than assumed (`setsFrom(tools)` derives from `_meta`, `TOOL_SETS`/`MUTATING_TOOLS` are derived, `DEFAULT_PERMISSIONS` covers all mutating)
- [x] Test: a tool in no set, or a mutating tool outside `MUTATING_TOOLS`, fails the suite (`test/tool-derive.test.ts`: 5 tests — `_meta` present, `TOOL_SETS` derived + exact-once + coverage, `MUTATING_TOOLS` derived, permissions coverage, mutating consistency)

### Subagent parallelism

Two independent searches run sequentially. The panel already renders several agents; the loop
does not fan out.

- [x] `task` accepts several investigations and runs them together (`src/subagent.ts`: `tasks: TaskSpec[]` union, `runOne` + `Promise.all` fan-out up to 8, panel emits start/step/result/end per subagent)
- [x] Test: two delegated searches overlap in time rather than queueing (`test/subagent-parallel.test.ts`: delayed greps overlap < 2*delay, both headings in one tool result)

### Undo a turn

Every comparable CLI has this: opencode `/undo` and `/redo`, Claude Code `/rewind` with
checkpoints. There is `/resume` here, which restores a session, and nothing that walks one back.

- [x] Snapshot files before each prompt, capped at the 100 most recent (`src/snapshot.ts` hook + `session.ts` per-turn capture, cap 100 via `SnapshotStack`)
- [x] `/undo` restores files, conversation, or both; `/redo` reverses it (`src/commands.ts` + `src/session.ts` `undo()`/`redo()` + `src/ui/App.tsx` — files+messages together, redo replays tail)
- [x] Say plainly what is not covered: a `bash` command's effects cannot be snapshotted (notice in undo/redo output + `src/snapshot.ts` doc)
- [x] Test: an edit is reverted, and the model's own record of it goes with it (`test/undo.test.ts`: undo file+messages, redo file+messages, bash-not-snapshotted, cap 100)

---

## Maintenance

- [x] Pricing table needs a source note and a date; rates drift and ours are hand-entered (`src/pricing.ts` `PRICING_VERIFIED_AT='2026-09-09'` + source URLs in doc, `/cost` shows `pricing verified: 2026-09-09 (est., verify before billing)`)
- [x] `estimateTokens` divides JSON length by four. Good enough for a compaction threshold,
      wrong enough to mislead in `/cost`. Either label it an estimate everywhere or use a
      real tokenizer (`src/prune.ts` doc now says heuristic + `(est.)` label, `src/session.ts`/`src/ui/panel-bodies.ts`/`src/ui/App.tsx` all display `~N tokens (est.)` / `~N est. in context`)
- [x] `listPaths` walks up to 5000 files once per session. Fine for a repo, wasteful in a
      monorepo, and it never notices a file created after the first `@` (`src/session.ts` `fileChangeSeq` bumped on `recordBeforeWrite` + `restoreFiles`, `src/ui/App.tsx` invalidates `paths` on seq change so next `@` re-walks)
- [x] `MUTATING_TOOLS` is now only used by tests and docs; the permission defaults are what
      actually gate a write. Either delete it or make the defaults derive from it (`src/permission.ts` `BASE_PERMISSIONS` + `buildDefaults()` derives mutating entries from `tools.ts` `MUTATING_TOOLS` via `require('./tools')` — `_meta.mutating` single source, fallback list if require fails)

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
- **An unknown name in `toolSets` is dropped silently.** The header line shows which sets
  actually loaded, but a typo reads as "that set is off" rather than as a mistake.
- **Permission rules gate the call, not what it does.** `bash` with `git *` allowed will run a
  `git` alias that shells out to anything, and there is no sandbox around the shell. Codex solves
  this with OS-level isolation — Seatbelt, Landlock, a Windows equivalent — which is three
  platform-specific implementations and not something to half-ship.
- **The reasoning panel is per-turn, not per-step.** Reasoning from an early step stays on
  screen through later ones until the turn ends.
- **An interrupted command's effects are unknown, and the model is told so.** Nothing can know
  how far a half-run migration got.
- **`@` completion lists files, not directories.** `@src/` narrows correctly, but you cannot
  complete to `src/` itself, because the walker only yields files.
- **An installed skill is a stranger's words in your system prompt.** The install shows the
  body first and `/skills` records the origin, but nothing re-checks it later: a registry that
  changes a URL's contents affects the next install, not one already on disk.
- **A registry index is trusted for its contents, not its authorship.** There are no
  signatures. `registryUrl` is the whole trust decision.

---

## Done

Kept for one release, then deleted. The 1.0.0 release batch:

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
