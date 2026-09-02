# TODO

Next up. One item, one outcome, verifiable when done.

Longer-term direction lives in [ROADMAP.md](ROADMAP.md).

---

## Now

### Summarize the pruned span

Compaction now keeps the model's memory of a turn, but it still tells the model nothing about
the messages it dropped, so a decision from forty messages ago can be contradicted with
confidence.

- [ ] Summarize the discarded messages before dropping them
- [ ] Inject the summary in place of the count
- [ ] Budget it: a summary that grows with the session defeats the point
- [ ] Test: a pruned decision is still recoverable from the summary

### A spend ceiling

A headless run that loops costs real money with nothing to stop it.

- [ ] `maxSpendUsd` in config, checked after every turn
- [ ] Warn at 80%, refuse to start another turn at 100%
- [ ] Headless exits non-zero with the ceiling named, rather than stopping silently
- [ ] Test: a session past its ceiling refuses the next turn and says why

### A cheaper model for subagents

The subagent shares the parent's model. An `explore` run is search, not reasoning, and it
currently pays the parent's per-token rate.

- [ ] `subagentModel` in config, defaulting to the parent
- [ ] `/cost` separates parent from subagent spend
- [ ] Test: the subagent's calls go to the configured model, the parent's do not

### Hot-reload an installed entry

`/registry add` writes the file and says to restart. The skill catalogue and the guard chain
are both assembled at boot, so a mid-session install does nothing until then.

- [ ] Rebuild the skill list and plugin host after an install or removal
- [ ] Leave a turn in flight alone: its rules must not change underneath it
- [ ] Test: a skill installed mid-session is callable in the next turn without a restart

---

## Next

### `web_fetch`

- [ ] URL to markdown, size-capped
- [ ] Belongs to a `net` set, off by default — it is the one tool that leaves the machine
- [ ] Test: a redirect is followed, an oversized body is truncated with a note

### Derive the tool-name lists

`TOOL_SETS` and `MUTATING_TOOLS` both list names by hand. A tool added to one and forgotten
in the other is a silently ungated write, which is the worst kind of bug this codebase can
have.

- [ ] Mark each tool as mutating where it is defined, not in a list beside it
- [ ] `TOOL_SETS` covers every registered tool, checked rather than assumed
- [ ] Test: a tool in no set, or a mutating tool outside `MUTATING_TOOLS`, fails the suite

### Subagent parallelism

Two independent searches run sequentially. The panel already renders several agents; the loop
does not fan out.

- [ ] `task` accepts several investigations and runs them together
- [ ] Test: two delegated searches overlap in time rather than queueing

---

## Maintenance

- [ ] Pricing table needs a source note and a date; rates drift and ours are hand-entered
- [ ] `estimateTokens` divides JSON length by four. Good enough for a compaction threshold,
      wrong enough to mislead in `/cost`. Either label it an estimate everywhere or use a
      real tokenizer
- [ ] `listPaths` walks up to 5000 files once per session. Fine for a repo, wasteful in a
      monorepo, and it never notices a file created after the first `@`

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

Kept for one release, then deleted.

- [x] Reasoning streamed to a collapsed panel, `ctrl-r` to expand, dropped when the turn ends
- [x] The tool in flight named on screen from `tool-input-start` until its result arrives
- [x] Prompts typed during a turn queue and drain in order; `esc` clears the queue
- [x] `toolSets` gating, so a disabled set reaches neither the wire nor the prompt
- [x] `multi_edit`, atomic across several edits to one file
- [x] `list_dir`, ignore-aware and depth-limited
- [x] Read-only git tools: `git_status` `git_diff` `git_log` `git_show` `git_blame`
- [x] Orphaned tool results dropped during pruning, fixing the 400 "No tool call found for
      function call output with call_id ..."
- [x] `read_many_files`, concurrent, one labelled block per file, a bad path reported in place
- [x] `@file` completion: picker fed by the ignore-aware walker, tab inserts a relative path
- [x] `ctrl-c` kills the running command and keeps the turn. The kill takes the whole process
      tree: killing `cmd /c` alone left the real command holding both pipes open, so the
      interrupt appeared to do nothing for 19 seconds
- [x] **Compaction no longer stops the loop.** Pruning used to drop any assistant part whose
      reasoning item it removed, which on a reasoning model is every tool call. The model lost
      its record of what it had run and re-ran it until the step limit. The repair strips the
      provider `itemId` instead of the part, so the same content is sent inline
- [x] `/registry`: browse, search, install, and remove external skills and plugins. Skills are
      shown in full before install; plugins are a validated manifest of deny rules, never code
- [x] Context shown as a percentage of the compaction threshold, amber at two thirds, red at 90
