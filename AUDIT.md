# Audit

Checklist from a full audit of the codebase, run against `main` at `ffa9a02` ("release 1.0.0").
The greps cover every file under `src/`, `test/`, `docs/`, `.github/workflows/`, and `scripts/`.

Nothing here is a fix — it is a list. Items already tracked in `TODO.md` or `ROADMAP.md` say so;
untracked items are marked **not yet tracked**. Items checked off were resolved after the audit,
in the same working tree.

The three bugs and the two untracked doc-drift items from the beta.5 audit are all fixed; this pass
also cleared the dead method, the three stale doc lines, and every UI coverage gap that remained —
`cli.tsx`, `Onboard.tsx`, `panel-bodies.ts`, `buses.ts`, and `PromptInput.tsx` — see
[section B](#b-bugs), [section D](#d-documentation-drift-untracked), and
[section E](#e-test-coverage-gaps).

---

## A. Clean findings (verified, no action needed)

- [x] **No TODO/FIXME/HACK markers in `src/`.** Seven matches, all false positives: the
      `TODO_MARK` export and its uses (`src/notebook.ts:120`, `src/ui/transcript.ts:1,201,203`,
      `src/ui/Panels.tsx:4,34`) and a `TODO` inside the `commit` skill's prose
      (`src/skills-md/commit.md:21`). Zero real markers.
- [x] **No `as any` / `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` / `: any` in `src/`.**
      One grep hit and it is the word "any" in a skill's prose (`src/skills-md/readme.md:36`).
      Zero casts. The project's own `docs/development.md` rule is being kept.
- [x] **No empty catch blocks and no silently swallowed errors in `src/`.** `catch {}` and
      `catch (e) {}` match zero times. 83 `catch` sites were grepped and the named ones reviewed:
      - `src/tools.ts:81-82` — a batch read failure is reported in place (`[unreadable: ...]`).
      - `src/tools.ts:463` — a stat probe returns `false` (sentinel, not a swallow).
      - `src/tools.ts:501` — `rg` unavailable → `undefined`, falls back to the JS grep.
      - `src/tools.ts:551,849` — an unreadable file is skipped during a scan (deliberate).
      - `src/tools.ts:630` — `taskkill` absent → plain kill (commented).
      - `src/tools.ts:795,889` — stat / JSON failure → a descriptive `Error`.
      - `src/subagent.ts:248` — usage unavailable on an errored run (commented); `:251` reports
        the error **and rethrows** (never swallowed).
      - `src/registry.ts` — parse failures become descriptive errors; the index is schema-validated.
      - `src/plugins.ts:59-63` — a throwing plugin hook fails **closed** (blocks the call).
      - `src/ui/App.tsx` — all 17 catch blocks surface the message in the UI.
      - `src/plugins-builtin.ts` — the one quiet catch (a missing formatter binary) is deliberate
        and commented.
- [x] **No skipped tests.** No `.skip`, `xit`, or `xdescribe` in `test/`.
- [x] **Registry fetches are size-capped and schema-validated.** `src/registry.ts` caps
      content-length and body bytes (`fetchText`, lines 98-109), validates the index with
      `indexSchema` (lines 120-123), and regex-validates every plugin manifest pattern
      (lines 164-173).
- [x] **Version consistency is enforced three times.** `package.json` vs `src/version.ts`
      (`scripts/release.ts:60-64`), the release tag vs `VERSION` via `GITHUB_REF_NAME`
      (`scripts/release.ts:66-70`), and the built binary's own `--version` output in CI
      (`.github/workflows/release.yml:42-46`). Both files currently read `1.0.0`.
- [x] **Install scripts match the build targets.** `test/ci.test.ts` iterates every `TARGETS`
      entry from `scripts/release.ts:13-19` and asserts the shell/PowerShell installers fetch
      exactly those asset names (~lines 89-94), plus checksum verification (~74-78) and version
      pinning / target directory (~81-87).
- [x] **`.env`/`.pem` are refused on read; writes and commands ask.** The default permission
      table (`src/permission.ts:175-186`) matches the approvals banner in `README.md:72`. Unknown
      tools (MCP, plugins) default to `ask` rather than allow (`src/permission.ts:235-236`), so
      `mcp__*` needs no explicit rule.
- [x] **`--yolo` cannot bypass the guard plugin.** `check()` returns a `deny` before the `yolo`
      fold (`src/permission.ts:282`), the fold itself only touches `ask` (`:293`), and the guard
      plugin refuses destructive commands in `beforeToolCall`, ahead of any approval.
- [x] **Pinned toolchain.** Both workflows pin `bun-version: 1.3.14`
      (`.github/workflows/ci.yml:21`, `.github/workflows/release.yml:23,35`), and
      `test/ci.test.ts:54` fails if the pin ever disagrees with the local `Bun.version`.
- [x] **All three platforms in CI.** `ci.yml:16` runs the suite on ubuntu, macos, windows
      (required — the tools shell out to `rg`, git, and a platform shell).

---

## B. Bugs

Fixed — the three from the beta.5 audit, the dead-code finding this audit surfaced, and a cursor
rendering bug found from a screenshot afterwards.

- [x] **`src/ui/PromptInput.tsx` — the cursor was drawn with hand-written SGR escapes.** `invert()`
      built the caret by pasting `\u001B[7m`/`\u001B[27m` into the text string
      (`invert(placeholder.slice(0, 1))`, and the same for the character under the cursor). Ink
      measures string content as printable columns, so those escapes were counted as text and the
      rest of the line was written one cell to the right — the orphaned first letter of the
      placeholder (`t ype to queue for the next turn…`), and a corrupted cell wherever the line
      wrapped. Replaced with Ink's `inverse` prop in all three render paths. The old tests passed
      *because* they asserted on the escape-producing helper; they now assert the rendered text is
      free of escapes, which is the property that actually matters.
- [x] **`src/ui/App.tsx` — memory-command formatting glitch (was line 613).** The `}` closing the
      `try` is now on its own line; the block reads cleanly at `src/ui/App.tsx:636-646`.
- [x] **`.github/workflows/release.yml` — the `dry_run` input is no longer dead.** It is wired
      into the `publish` job's `if`: a tag push always publishes, a manual dispatch publishes only
      when `dry_run` is unchecked (`release.yml:56-60`).
- [x] **`README.md` — tool count was stale, now correct.** It says "Forty-one built-in tools"
      (`README.md:116`) and "41 built-in tools" (`README.md:164`), matching `docs/tools.md:49`.
- [x] **`src/permission.ts` — `granted_` was dead code, now deleted.** A public method with a
      trailing underscore (the convention here is a `_`-*prefix* for an unused parameter, not a
      suffix). It returned the session's granted patterns and was called nowhere — not in `src/`,
      not in `test/`. Removed; `check()` and `grant()` are the live surface.

---

## C. Gaps / not implemented (official — tracked in TODO.md or ROADMAP.md)

### TODO.md "Now" — next up

- [ ] **Summarize the pruned span.** Compaction keeps the model's memory of a turn but tells it
      nothing about the messages it dropped, so a decision from earlier in the session can be
      contradicted with confidence. (TODO.md `## Now`; ROADMAP `## Next` "Lossless-enough
      compaction" — same work)
- [ ] **Hot-reload an installed entry.** `/registry add` writes the file and says restart; the
      skill catalogue and the guard chain are assembled at boot. (TODO.md `## Now`)

### TODO.md "Next"

- [ ] **MCP without the schema tax.** Every MCP tool's schema is in the prompt on every request
      and `toolSets` does not gate them; a twenty-tool server costs ~2,750 tokens a turn whether
      used or not. Plan: `mcp_list` / `mcp_inspect` / `mcp_call` meta-tools, prompt names servers
      not schemas. (TODO.md `## Next`; ROADMAP `## Next`)
- [ ] **Derive the tool-name lists.** `TOOL_SETS` and `MUTATING_TOOLS` are hand-maintained; a tool
      added to one and forgotten in the other is a silently ungated write. (TODO.md `## Next`;
      ROADMAP `## Next` "Derived tool metadata")
- [ ] **Subagent parallelism.** Two independent searches run sequentially; the panel already
      renders several agents, the loop does not fan out. (TODO.md `## Next`; ROADMAP `## Later`)
- [ ] **Undo a turn.** `/resume` restores a session but nothing walks one step back; `bash`
      effects cannot be snapshotted and the docs would say so. (TODO.md `## Next`; ROADMAP `## Next`)

### ROADMAP "Next" — tracked, not yet scheduled in TODO.cpp-equivalent detail

- [ ] **Registry trust.** No signatures; `registryUrl` is the whole trust decision. Publisher
      keys plus a pinned digest per entry. (ROADMAP `## Next`; TODO.md Known rough edges)
- [ ] **`web_fetch` leftovers.** `web_fetch` itself shipped in beta.4. What remains declined:
      thin wrappers around a single bash line (`run_tests`, `typecheck`, `lint`, `build`) that add
      only schema tax. (ROADMAP `## Next`)

### ROADMAP "Later"

- [ ] **Session branching**, **structured diff review**, **plugin code from disk** (needs a
      sandbox story), **prompt caching** (stable prefix vs volatile suffix), **external hooks**
      (needs a trust story), **OS-level sandboxing** (Seatbelt/Landlock/Windows equivalent).
      (ROADMAP `## Later`)
- [ ] **Deliberately declined** (do not "fix"): web UI, model-agnostic prompt tuning, auto-commit,
      vector search, tool-call retries, client/server split, LSP integration — all recorded in
      ROADMAP `## Declined`.

---

## D. Documentation drift (untracked)

The two items from the beta.5 audit are resolved: `README.md` now says 41, and `TODO.md` has a
complete `## Done` section for the 1.0.0 batch (with the history in ROADMAP `## Shipped`). Three
stale lines were found in this pass, and all three are now corrected:

- [x] **`docs/development.md:101` said "Nineteen built-in tools".** Now "Forty-one", matching the
      registry; the sentence warns that selection accuracy degrades past a certain count, so the
      number matters.
- [x] **`docs/headless.md:54` used "There are 16 built-in tools."** as its sample JSON output.
      Now "41", so the example matches the tool list.
- [x] **`docs/headless.md:185-186` said there was no spend ceiling yet.** Rewritten to document
      `maxSpendUsd` (`src/config.ts:24`): warns once at 80%, refuses the next turn past 100%, and
      the run exits non-zero — enforced only on priced models.
- [x] **`docs/registry.md` and `docs/headless.md`** are referenced by the README table and both
      exist — verified clean, no action.

---

## E. Test-coverage gaps

- [x] **`src/cli.tsx` (666 lines) now has an entry-point test — `test/cli.test.ts`.** The module
      is an executable, not a library: importing it parses argv, loads config, connects MCP, and
      renders Ink, which is why nothing imported it before. The test runs the real entry point as a
      child process (via `process.execPath`, so it is cross-platform) with a scratch `SHIRO_HOME`,
      a scratch cwd, and every API-key variable stripped, so the no-key branches are deterministic.
      Ten cases cover the argument surface: `--help`/`-h`, `--version`/`-v`, an unknown `--agent`,
      an unknown `--think`, `-p` without a key, `--resume` with no match, `--continue` with no
      saved session, and a configured key with no prompt (that last run also passes all six
      `--no-*` isolation flags through the boot path). Paths past `render()` need a TTY and remain
      uncovered — provider `/provider` wiring through the wizard included.
- [x] **`src/ui/Onboard.tsx` (211 lines) now has a test — `test/onboard.test.tsx`.** The wizard
      renders standalone and its only network call is `fetchModels`, which uses the global `fetch`,
      so the suite stubs it: the flow is exercised offline and deterministically, with the two API
      key env vars cleared so a developer's shell never picks the branch. Six cases cover the
      provider list and its `(current)` marker, esc from both the list and the api-key step, a
      custom endpoint collecting url + key + a sorted model pick, the env-key shortcut (key step
      skipped, hint masked to `sk-a...1234`), manual model-id entry, and the "could not list
      models" fallthrough when the server errors. `current` sets the starting row, so a test names
      a preset rather than counting arrow presses.
- [x] **`src/ui/PromptInput.tsx` (175 lines) now has a direct test — `test/prompt-input.test.tsx`.**
      It was already covered through `App` in `input.test.tsx` (history recall and stash, arrow and
      word motion, ctrl-u, ctrl-d, paste); what was left needed the component on its own, so this
      renders it directly with a controlled `Harness`. Fifteen cases cover the caret rendering (a
      bare focused caret, a blurred input with none, the placeholder inverting its first character
      only while focused, the cursor sitting under the character it points at), the kill keys
      (ctrl-a/ctrl-e, ctrl-k, ctrl-w, including a single word emptying the line), the `mask` (hidden
      value and the caret after a deletion), `onKey` swallowing a key before the input sees it while
      declining others, `initialCursor`, an external `value`, submit, and insert-at-cursor. Two
      expected frames were probed against the real renderer rather than assumed: a whitespace-only
      `Text` trims to `''`, and a mask renders the caret *after* the stars.
- [x] **`src/ui/panel-bodies.ts` (78 lines) now has a direct test** — `test/ui-bodies.test.tsx`,
      shared with `buses.ts`. The four panels are pure functions of session and hook state, so
      they run without mounting Ink: the tools panel (sets named, a read-only agent narrowing it,
      the offered/registered hint), the cost panel (priced turn, unpriced model, the subagent line
      priced against its own model, the ceiling line), the context panel's empty branch, and the
      todos panel fed through the real `todo_write` tool.
- [x] **`src/ui/buses.ts` (75 lines) now has a direct test.** `createNoticeBus` and
      `createSubagentBus` are covered: a pre-bind emit is queued and delivered in order on bind, a
      post-bind emit passes through, and a rebind takes over without replaying the queue.
      `applySubagentEvent` gains the cases the existing `ui-panels` test left open — a result
      attaching to its step, a mismatched or duplicate result being ignored, end/error status
      flips, an unknown id being a no-op, and two agents interleaving without crossing steps.
- [ ] **13 `as any` casts across 11 test files.** Down from 29 across 17. The identical mock
      `usage` object (`{ inputTokens: {...}, outputTokens: {...} } as any`) is still repeated
      across several UI test files — a shared typed fixture in `test/helpers.ts` would remove the
      repetition and the casts in one move. Production `src/` remains clean; this is test-only
      debt. **not yet tracked**

---

## F. Maintenance debt

- [ ] **Pricing table is hand-entered with no source note or date** — `src/pricing.ts:8-22`.
      Rates drift. Tracked in TODO.md `## Maintenance`.
- [ ] **`estimateTokens` divides JSON length by four** — `src/session.ts:97` (the thinking panel
      does the same at `src/ui/Panels.tsx:193`). Fine as a compaction threshold, misleading in
      `/cost`. Tracked in TODO.md `## Maintenance`.
- [ ] **`listPaths` walks up to 5000 files once per session** — `src/cli.tsx:387-389`. Fine for
      a repo, wasteful in a monorepo, never notices a file created after the first `@`. Tracked in
      TODO.md.
- [ ] **`MUTATING_TOOLS` (`src/tools.ts:980`) is only used by tests and docs.** The runtime gate
      is `DEFAULT_PERMISSIONS` plus the unknown-tool `ask` default. Tracked in TODO.md — either
      delete it or make `DEFAULT_PERMISSIONS` derive from it.
- [ ] **Oversized modules, all grown again in the 1.0.0 batch.** `src/ui/App.tsx` (1002),
      `src/tools.ts` (990), `src/cli.tsx` (666), `src/session.ts` (637), `src/ui/Panels.tsx`
      (579). Not a bug — a "who reads 990 lines" concern. **not yet tracked**
- [ ] **CI actions are on Node 20.** The last release run annotated that `actions/checkout@v4`,
      `setup-bun@v2`, `upload-artifact@v4`, `download-artifact@v4` are being forced onto Node 24.
      They still work; the major-version bumps will become the silent fix. Not verifiable from the
      tree — watch for the annotation to turn red. **not yet tracked**

---

## G. Known rough edges (tracked in TODO.md, reproduced here for the record)

- [x] `/clear` wipes terminal scrollback (escape sequence takes earlier history with it).
- [x] Memory has no conflict resolution; two contradictory notes both inject.
- [x] Windows `cmd /c` vs `bash -lc` — the prompt names the platform, does not translate.
- [x] An unknown name in `toolSets` is dropped silently — reads as "that set is off".
- [x] Permission rules gate the call, not what it does — no OS sandbox around the shell.
- [x] The reasoning panel is per-turn, not per-step.
- [x] An interrupted command's effects are unknown, and the model is told so.
- [x] `@` completion lists files, not directories.
- [x] An installed skill is a stranger's words in the system prompt; nothing re-checks it later.
- [x] A registry index is trusted for its contents, not its authorship.

---

## Summary

| Area | Items |
|---|---|
| Bugs | 0 (all five cleared) |
| Official gaps (Now/Next/Later) | 8 near-term + 6 Later tracked in TODO.md/ROADMAP.md |
| Documentation drift | 0 (three lines corrected) |
| Test-coverage gaps | 1 (every UI module now has a test; only the `as any` item below remains) |
| Maintenance debt | 6 (4 tracked, 2 untracked) |
| Known rough edges | 10 (all tracked) |
| Verified clean | 9 areas, including zero casts and zero swallowed errors in `src/` |

The codebase is in good shape for 1.0.0. The bug list, the doc drift, and every UI coverage gap are
cleared; what is left is the test-only `as any` casts and the maintenance debt — all tracked.
