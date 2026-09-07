# Audit

Checklist from a full audit of the codebase, run against `main` at `a22d8e1` ("release 0.1.0-beta.5").
The greps cover every file under `src/`, `test/`, `docs/`, `.github/workflows/`, and `scripts/`.

Nothing here is a fix — it is a list. Items already tracked in `TODO.md` or `ROADMAP.md` say so;
untracked items are marked **not yet tracked**.

---

## A. Clean findings (verified, no action needed)

- [x] **No TODO/FIXME/HACK markers in `src/`.** All 26 matches are false positives:
      placeholder attributes, the `TODO_MARK` export in `src/notebook.ts` (a literal string
      ingredient of the todos feature), and "later" in prose.
- [x] **No `as any` / `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` / `: any` in `src/`.**
      Zero matches. The project's own `docs/development.md` rule is being kept.
- [x] **No silently swallowed errors in `src/`.** Every `catch` was reviewed:
      - `src/registry.ts:116,155` — JSON parse failures become descriptive errors.
      - `src/registry.ts:120-123,159-162` — zod schema validation with named failure reasons.
      - `src/plugins.ts:59-63` — a throwing plugin hook fails **closed** (blocks the call).
      - `src/subagent.ts:233-237` — errors are reported and rethrown (never swallowed).
      - `src/tools.ts:80-82` — a batch read failure is reported in place, not thrown.
      - `src/headless.ts` serialization flattens `Error` before `JSON.stringify` (would emit `{}`).
      - `src/ui/App.tsx` — all 14 catch blocks surface the message in the UI.
      - `src/plugins-builtin.ts:213-215` — the only quiet `catch`, and it is deliberate,
        commented ("a missing binary is not worth interrupting the turn over").
- [x] **No skipped tests.** No `.skip`, `xit`, or `xdescribe` in `test/` (one match was
      `process.exit(` containing "xit(").
- [x] **Registry fetches are size-capped and schema-validated.** `src/registry.ts` caps
      content-length and body bytes (`fetchText`, lines 100-108), validates the index with
      `indexSchema` (line 120), and regex-validates every plugin manifest pattern (line 167).
- [x] **Version/tag consistency is enforced twice.** `scripts/release.ts` refuses a build when
      the tag and `src/version.ts` disagree (line 129), and the release workflow asserts the
      built binary prints the expected version (`.github/workflows/release.yml:42-46`).
- [x] **Install scripts match the build targets.** `test/ci.test.ts:85-101` iterates every
      `TARGETS` entry from `scripts/release.ts` and asserts the shell/PowerShell installers
      fetch exactly those asset names.
- [x] **`.env`/`.pem` are refused on read;** the default permission table
      (`src/permission.ts:175-186`) matches the approvals banner in `README.md`. Unknown tools
      (MCP, plugins) default to `ask` rather than allow (line 235-236), so `mcp__*` needs no
      explicit rule.
- [x] **`--yolo` cannot bypass the guard plugin.** Defaults fold `ask` into `allow` but never
      touch `deny` (`src/permission.ts:211-213`), and the guard refuses destructive commands
      in `beforeToolCall`, ahead of any approval.
- [x] **Pinned toolchain.** Both workflows pin `bun-version: 1.3.14`, and `test/ci.test.ts:48-52`
      fails if the pin ever disagrees with the local `Bun.version`.
- [x] **All three platforms in CI.** `ci.yml` runs the suite on ubuntu, macos, windows
      (required — the tools shell out to `rg`, git, and a platform shell).

---

## B. Bugs

- [ ] **`src/ui/App.tsx:613` — formatting glitch.** The `}` closing the `try` is jammed onto the
      same line as the preceding statement:
      `push({ kind: 'info', text: await hooks.summarizeMemory() });          } catch (e) {`
      Cosmetic only, but it is the kind of blemish left by an unformatted edit and reads as a
      slip. **not yet tracked**
- [ ] **`.github/workflows/release.yml` — the `dry_run` input is dead.** `workflow_dispatch`
      declares `inputs.dry_run` (default `true`) but no step ever reads it. Nothing consults the
      value, so `dry_run=false` changes nothing, and because the `publish` job gates on
      `startsWith(github.ref, 'refs/tags/v')`, a manual run can never publish regardless of the
      input. Either wire the input into the `publish` `if`, or delete it and let the tag-only
      gate be the whole story. **not yet tracked**
- [ ] **`README.md` says "Nineteen built-in tools" — it is now twenty.** `git_commit_message`
      (shipped in beta.5 via `src/commit.ts` + `cli.tsx:281`) is a built-in tool, and
      `TOOL_SETS.git` carries it (`src/tools-git.ts:189`). The count is one short;
      `docs/tools.md` already says "twenty" (line 63), so README is the stale one.
      **not yet tracked**

---

## C. Gaps / not implemented (official — tracked in TODO.md or ROADMAP.md)

### TODO.md "Now" — next up

- [ ] **Summarize the pruned span.** Compaction drops messages and tells the model nothing, so a
      decision from earlier in the session can be contradicted. (TODO.md `## Now`, first item)
- [ ] **A spend ceiling.** `maxSpendUsd` in config, warn at 80%, refuse the next turn at 100%,
      headless exits non-zero naming the ceiling. Nothing stops a looping headless run today.
      (TODO.md `## Now`)
- [ ] **A cheaper model for subagents.** `subagentModel` in config; an `explore` subagent is
      search, not reasoning, and today pays the parent's per-token rate. (TODO.md `## Now`)
- [ ] **Hot-reload an installed entry.** `/registry add` writes the file and says restart; the
      skill catalogue and guard chain are assembled at boot. (TODO.md `## Now`)

### TODO.md "Next"

- [ ] **MCP without the schema tax.** Twenty MCP tools ≈ 2,750 tokens of schema per request;
      `toolSets` does not gate them. Plan: `mcp_list` / `mcp_inspect` / `mcp_call` meta-tools,
      prompt names servers not schemas. (TODO.md `## Next`; ROADMAP `## Next` + `## Later`)
- [ ] **Custom commands from a file.** `.shiro/commands/*.md`, `$ARGUMENTS`, `$1`,
      `` !`cmd` `` shell substitution with the guard applied. (TODO.md `## Next`; ROADMAP `## Next`)
- [ ] **Derive the tool-name lists.** `TOOL_SETS` and `MUTATING_TOOLS` are hand-maintained; a
      tool added to one and forgotten in the other is a silently ungated write. (TODO.md
      `## Next`; ROADMAP `## Next` "Derived tool metadata")
- [ ] **Subagent parallelism.** Two independent searches run sequentially; the panel already
      renders several agents, the loop does not fan out. (TODO.md `## Next`; ROADMAP `## Later`)
- [ ] **Undo a turn.** `/resume` restores a session but nothing walks one step back; `bash`
      effects cannot be snapshotted and the docs would say so. (TODO.md `## Next`; ROADMAP `## Next`)

### ROADMAP "Next" / "Later" — tracked, not yet scheduled in TODO.cpp-equivalent detail

- [ ] **Registry trust.** No signatures; `registryUrl` is the whole trust decision. Publisher
      keys + pinned digest per entry. (ROADMAP `## Next`; also TODO.md Known rough edges)
- [ ] **Lossless-enough compaction** — same work as "Summarize the pruned span". (ROADMAP `## Next`)
- [ ] **Session branching**, **structured diff review**, **plugin code from disk** (needs a
      sandbox story), **prompt caching** (stable prefix vs volatile suffix), **external hooks**
      (needs a trust story), **OS-level sandboxing** (Seatbelt/Landlock/Windows equivalent).
      (ROADMAP `## Later`)
- [ ] **Deliberately declined** (do not "fix"): web UI, auto-commit, vector search, tool-call
      retries, client/server split, LSP integration — all recorded in ROADMAP `## Declined`.

---

## D. Documentation drift (untracked)

- [ ] **README tool count** — see Bug B.3. **not yet tracked**
- [ ] **TODO.md "Done" is missing the rest of beta.5.** "Kept for one release, then deleted",
      but of the beta.5 batch (more tools incl. `git_branch`/`git_commit_message`/
      `move_file`/`delete_file`, the `protect` plugin, `security`/`perf`/`migrate` skills, the
      MCP panel wizard, the UI refinements, the farewell message) only "a dead provider item
      ends the turn" was checked off. Either the Done list gets the beta.5 items or it gets
      rotated, as the file's own rule says. **not yet tracked**
- [ ] **`docs/registry.md` and `docs/headless.md`** are referenced by the README table and both
      exist — verified clean, no action.

---

## E. Test-coverage gaps

- [ ] **`src/cli.tsx` (562 lines) has no unit test.** Nothing in `test/` imports it. Its flag
      parsing (`-p`, `--json`, `--yolo`, `--resume`, provider setup, `/provider` wiring) is
      exercised only by hand or through `runHeadless` (`test/headless.test.ts`), which bypasses
      the argument surface. The largest module in `src/` outside the UI is the least tested one.
      **not yet tracked**
- [ ] **`src/ui/Onboard.tsx` has no test.** The provider on-boarding wizard is never rendered in
      the suite. **not yet tracked**
- [ ] **`src/ui/PromptInput.tsx` has no test** — the `@` completion input is only covered
      indirectly through `App`. (`src/complete.ts` itself is well tested.) **not yet tracked**
- [ ] **`src/ui/panel-bodies.ts` and `src/ui/buses.ts` have no direct tests.**
      **not yet tracked**
- [ ] **29 `as any` casts across 17 test files.** The identical mock `usage` object
      (`{ inputTokens: {...}, outputTokens: {...} } as any`) is copied verbatim in 7+ UI test
      files — a shared typed fixture in `test/helpers.ts` would remove the repetition and the
      casts in one move. Production `src/` remains clean; this is test-only debt. **not yet tracked**

---

## F. Maintenance debt

- [ ] **Pricing table is hand-entered with no source note or date** — `src/pricing.ts:8-22`.
      Rates drift; `estimateTokens` also divides JSON length by four (session.ts:90), which is
      fine as a compaction threshold but misleads in `/cost`. Both tracked in TODO.md
      `## Maintenance`.
- [ ] **`listPaths` walks up to 5000 files once per session** — fine for a repo, wasteful in a
      monorepo, never notices a file created after the first `@`. Tracked in TODO.md.
- [ ] **`MUTATING_TOOLS` (tools.ts:799-807) is only used by tests and docs.** The runtime gate
      is `DEFAULT_PERMISSIONS` + the unknown-tool `ask` default. Tracked in TODO.md — either
      delete it or make `DEFAULT_PERMISSIONS` derive from it.
- [ ] **CI actions are about to leave Node 20.** The last release run annotated that actions on
      Node 20 are being forced onto Node 24. `actions/checkout@v4`, `setup-bun@v2`,
      `upload-artifact@v4`, `download-artifact@v4` still work, but the major-version bumps will
      become the silent fix; watch for the annotation to turn red. **not yet tracked**
- [ ] **Oversized modules.** `src/ui/App.tsx` (863), `src/tools.ts` (717), `src/cli.tsx` (562),
      `src/session.ts` (500), `src/ui/Panels.tsx` (398). All of them grew past a comfortable
      review size during the beta.5 batch. Not a bug — a "who reads 863 lines" concern.
      **not yet tracked**

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
| Bugs | 3 (`App.tsx:613`, dead `dry_run` input, README tool count) |
| Official gaps (Now/Next/Later) | 14 tracked in TODO.md/ROADMAP.md |
| Documentation drift | 2 untracked |
| Test-coverage gaps | 5 (of which `src/cli.tsx` is the significant one) |
| Maintenance debt | 5 (3 tracked, 2 untracked) |
| Known rough edges | 10 (all tracked) |
| Verified clean | 9 areas, including zero `as any` and zero swallowed errors in `src/` |

The codebase is in good shape for a beta. The three bugs are each one-line fixes; the
coverage gap on `cli.tsx` is the item that will actually bite.