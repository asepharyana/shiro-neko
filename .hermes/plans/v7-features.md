# Plan: 7 new features for shiro-neko

Scope: add 7 features to the shiro-neko codebase. All touch `src/session.ts` and related
files. Tests follow existing patterns (bun:test, MockLanguageModelV4, mkdtemp chdir).

## Features

### 1. Turn change summary (`/changes`)
**Files:** `src/session.ts`, `src/commands.ts`, `src/ui/App.tsx`, `src/ui/panel-bodies.ts`, `test/changes.test.ts`

Reuse undo snapshot infra: after turn, diff `turnBeforeFiles` vs `afterFiles`.
- `Session.lastTurnSummary(): ChangeSummary | undefined` — returns `{ added: string[], modified: string[], deleted: string[] }` from the most recent snapshot's beforeFiles vs afterFiles.
- Add `ChangeSummary` type exported from `src/session.ts`.
- `/changes` command in `src/commands.ts` (type `'changes'`).
- `changesPanel()` in `src/ui/panel-bodies.ts`.
- Wire in `App.tsx` switch case + show after 'done' if files were changed.
- Test: create files, write_file, assert summary has them; empty turn → undefined.

### 2. System prompt memoization
**Files:** `src/session.ts`, `test/prompt-cache.test.ts`

Version counters on volatile parts: `notebookVersion`, `memoryVersion`, `skillVersion`, `pluginVersion`, `toolVersion`.
- `Session` stores a version map `{notebook, memory, skill, plugin, tool}`.
- Bump versions: `onNotebookChange` already bumps notebook; memory.add/bump triggers callback; skills/plugins rebuilt → increment; tools rebuilt → increment.
- Cache `{versionKey: string, text: string}` in Session.
- `systemFor()` builds versionKey from all 5, returns cache hit if identical.
- Expose `Session.promptCacheStats(): {hits: number, misses: number}` for /cost.
- Test: two calls with same version → cache hit; bump one → miss.

### 3. Web search tool (`web_search`)
**Files:** `src/tools-net.ts`, `test/tools-net.test.ts`

Add `web_search` to `netTools` (same set as `web_fetch`, opt-in).
- Backend: `config.search?.backend` (default `'duckduckgo-lite'`).
- Implementation: fetch `https://lite.duckduckgo.com/lite/?q=<encoded>` → parse result HTML for title+url+snippet. No API key needed.
- Max 5 results. Return as numbered markdown list.
- `checkUrl` for safety on results, skip any that resolve private.
- Description: "Search the web for information. Returns up to 5 results with titles, URLs, and snippets."
- Export `NET_TOOL_NAMES` includes `web_search`.

### 4. `/search` — search saved sessions
**Files:** `src/store.ts`, `src/commands.ts`, `src/ui/App.tsx`, `test/search.test.ts`

Full-text grep over session transcripts on disk.
- `store.searchSessions(query: string, limit?: number): SessionRecord[]` — case-insensitive substring match on `title` and serialized `messages[].content` (string only; JSON content stringified for matching).
- `/search <query>` command (type `'search'`).
- Returns panel with matching sessions: id prefix, title, first matched line.
- Test: save session with specific content, search, assert match.

### 5. Workspace file refresh at turn boundary
**Files:** `src/session.ts`, `src/cli.tsx` (minor), `test/workspace-refresh.test.ts`

When `fileChangeSeq` bumps (files written this turn), re-walk workspace at turn end.
- `Session.refreshWorkspaceFiles(): void` — re-runs `walk()` and updates `this.opts.workspaceFiles`. Only if `fileChangeSeq > lastWalkSeq`.
- Track `lastWalkSeq` in Session.
- Call in `send()` finally block, after `drainPendingHotReload`.
- Expose `Session.setWorkspaceFiles(files)` for tests.
- Test: start with empty workspace, write file via write_file, refresh, assert file appears.

### 6. Per-turn spend cap
**Files:** `src/session.ts`, `src/config.ts`, `src/ui/panel-bodies.ts`, `test/spend.test.ts`

- `maxSpendPerTurn?: number` in `SessionOptions` + `Config`.
- In `send()`, snapshot `this.spend().usd` at turn start. At each step completion (after usage), check if spend delta exceeds cap → abort with notice.
- `/cost` shows per-turn cap if set.
- Config loading: `config.maxSpendPerTurn` optional number.
- Test: mock model, set tiny cap, assert turn stops early.

### 7. `/fork` — fork session at a turn
**Files:** `src/session.ts`, `src/commands.ts`, `src/ui/App.tsx`, `test/fork.test.ts`

- `Session.fork(atIndex?: number): ModelMessage[]` — takes messages up to `atIndex` (default: before the last user message), returns deep-cloned copy. Does NOT modify current session.
- `/fork` command (type `'fork'`) — forks to a new in-memory session with the cloned messages, preserving same options. Returns the new session's id.
- For simplicity: `/fork` clones messages up to the second-to-last user message, pushes into a new session object, and reports the id. The user then `/resume` the forked session.
- Test: build session with 3 turns, fork at -1, assert copy has 1 fewer user message.

## Verification

```
bun run typecheck
bun test
bun run build
```
