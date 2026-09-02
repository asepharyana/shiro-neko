# TODO

Next up. One item, one outcome, verifiable when done.

Longer-term direction lives in [ROADMAP.md](ROADMAP.md).

---

## Now

### Show reasoning in the transcript

`src/session.ts` already yields `{ type: 'reasoning' }`; `src/ui/App.tsx` ignores it.

- [ ] Accumulate reasoning deltas into their own buffer, separate from `text`
- [ ] Render as a dim collapsed panel: `thinking... 412 tokens`, expandable with a key
- [ ] Drop it from the transcript when the turn ends — reasoning is not part of the answer
- [ ] Test: a model emitting `reasoning-delta` puts text on screen before any `text-delta`

### Show the file being touched

`tool-call` carries the path but the transcript only shows a summary after the call returns.

- [ ] Render an active-tool line while a call is in flight: `read src/session.ts`
- [ ] Clear it on `tool-result` or `tool-error`
- [ ] Test: a slow tool leaves its line on screen for the duration

### Queue prompts typed during a turn

- [ ] Keep `PromptInput` mounted while `busy`, alongside the spinner
- [ ] Submitting while busy appends to a queue and shows `queued: 2`
- [ ] Drain the queue in order when the turn ends
- [ ] `esc` clears the queue as well as aborting
- [ ] Test: two prompts typed during a turn run in order afterwards

---

## Next

### `activeTools` gating per tool set

Needed before the tool count grows. Measured at 553 chars of schema per tool per request.

- [ ] `toolSets` in config: which sets are live
- [ ] Sets: `core`, `git`, `edit-plus`, `net`
- [ ] `prepareStep` narrows `activeTools` to the enabled sets
- [ ] `/tools` shows which set each tool came from
- [ ] Test: a disabled set's tools reach neither the wire nor the prompt

### `multi_edit`

- [ ] Several `{ oldString, newString }` edits against one file
- [ ] Atomic: any failing match aborts the whole call, file untouched
- [ ] Each edit applied to the result of the previous one
- [ ] Approval prompt shows one combined diff
- [ ] Test: a failing second edit leaves the file exactly as it was

### `list_dir`

- [ ] Tree view honouring `.gitignore`, depth-limited, entry-capped
- [ ] Marks directories and shows file sizes
- [ ] Test: respects ignore rules, stops at the depth limit

### Git read-only tools

All approval-free, since none can mutate.

- [ ] `git_status`, `git_diff`, `git_log`, `git_show`, `git_blame`
- [ ] Structured output, not raw porcelain
- [ ] Fail clearly outside a repo instead of returning git's error text
- [ ] Test: each returns something usable in a temp repo, and a clean error outside one

### `@file` completion

- [ ] `@` in the input opens a path picker fed by the ignore-aware walker
- [ ] Tab completes, continued typing narrows
- [ ] Completed path inserted as a plain relative path
- [ ] Test: `@src/` narrows to files under `src/`

---

## Maintenance

- [ ] Pricing table needs a source note and a date; rates drift and ours are hand-entered
- [ ] `estimateTokens` divides JSON length by four. Good enough for a compaction threshold,
      wrong enough to mislead in `/cost`. Either label it an estimate everywhere or use a
      real tokenizer
- [ ] The subagent shares the parent's model. A cheaper model for search would cut cost
      substantially on `explore` runs
- [ ] No spend ceiling. A headless run that loops costs real money with nothing to stop it

---

## Known rough edges

Not bugs exactly, but things that will bite someone.

- **`/clear` wipes the terminal scrollback.** `<Static>` output is already committed, so
  clearing React state alone leaves it on screen. The escape sequence works but takes the
  user's earlier terminal history with it.
- **Compaction is lossy in a way the model cannot see.** It is told the history was pruned,
  but not what was in the pruned part. A summary of the discarded span would be better than
  a count.
- **Memory has no conflict resolution.** Two contradictory notes both persist and both get
  injected. `/memory` may merge them, or may keep both.
- **`bash` cannot be interrupted independently.** `esc` aborts the whole turn, killing the
  command. There is no way to stop a runaway command and keep the turn.
- **Windows `cmd /c` differs from `bash -lc`.** A command the model writes for one shell may
  fail on the other. The prompt states the platform; it does not translate.
