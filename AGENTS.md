# shiro-neko

Agentic coding CLI, built with Bun + TypeScript. The interactive UI is React rendered to the
terminal with Ink; LLM access goes through the Vercel AI SDK (`ai`) with Anthropic, OpenAI,
OpenAI-compatible, and MCP providers. Entry point and only executable is `src/cli.tsx` (bin `shiro`).

## Commands

- `bun install --frozen-lockfile` — install deps (CI uses this; lockfile is `bun.lock`)
- `bun run shiro` — run the CLI from source (i.e. `bun run src/cli.tsx`)
- `bun test` — full test suite (`bun:test`, no other runner)
- `bun run typecheck` — `tsc --noEmit`; must pass before committing
- `bun run build` — `bun build --compile` to `dist/shiro` (single native binary)
- `bun run release` — cross-compile all five targets into `dist/release/`
- No linter or formatter is configured; don't invent one.

CI (`.github/workflows/ci.yml`) runs install → typecheck → test → build on Ubuntu, macOS, and
Windows, pinned to Bun 1.3.14. Everything must be cross-platform: the tools shell out to the
platform shell, and paths in code and tests go through `node:path`, never hardcoded `/`.

## Layout

- `src/` — flat modules, one concern per file, lowercase names (`session.ts`, `prune.ts`).
  `src/ui/` holds the Ink components, PascalCase (`App.tsx`, `Panels.tsx`).
- `test/` — one `<name>.test.ts` per `src/<name>.ts`; `*.test.tsx` for UI tests via
  `ink-testing-library`. `test/helpers.ts` has `testHooks()`, the standard App fixture.
- `docs/` — user-facing docs, one per feature area.
- `scripts/` — `release.ts`, `install.ts` (+ `.sh`/`.ps1` installers).
- `src/version.ts` — hardcoded VERSION; the release workflow fails if it disagrees with the git tag.

## Conventions

- ES modules, `verbatimModuleSyntax` on: import types with `import type`. Strict TS with
  `noUncheckedIndexedAccess` — indexing gives `T | undefined`, so handle it (`arr[i]!` appears
  where provably safe).
- Uses Bun APIs directly (`Bun.file`, `Bun.write`, `Bun.spawn`, `Bun.Glob`) — no fs-extra, no
  node shims. File tools read/write through `Bun.*`, not `fs`, where practical.
- Path safety: every user/model-supplied path goes through `jail()` (in `src/ignore.ts`), which
  rejects escapes outside `process.cwd()`. Tools resolve paths against `process.cwd()`.
- Error handling: tool `execute` functions return error text to the model or throw `Error` with a
  plain message — no error classes, no codes. Storage reads (`store.ts`, `memory.ts`) catch and
  degrade to empty rather than throw on corrupt JSON.
- Tools are AI-SDK `tool()` objects with zod `inputSchema`. Any tool that mutates the workspace
  must be added to `MUTATING_TOOLS` in `src/tools.ts` — a test in `permission.test.ts` fails
  otherwise. The permission system (`src/permission.ts`) matches rules against the tool's subject
  (command for `bash`, path for file tools) with glob matching, and is pure/no-IO on purpose.
- Comments explain *why*, often naming the failure being guarded against. Match that style.
- Tests import from `bun:test`, build mock models with `MockLanguageModelV4` +
  `simulateReadableStream` from `ai/test`, and each test that touches the filesystem does
  `process.chdir()` into a fresh `mkdtemp` dir in `beforeEach` and restores in `afterEach`.

## Surprising / easy to break

- `bun test` runs the whole suite including `fallback-live.test.ts`, which spins up real local
  HTTP servers via `Bun.serve`, and `commit.test.ts`, which runs real `git` in temp repos — both
  need a working network stack and git on PATH.
- Tool output is capped (`MAX_OUTPUT` in `src/tools.ts`); read_file returns NUL-sniffed binary
  files as an error. Don't remove these — they stop a model from burning its context.
- Ink renders to the terminal, so library warnings are suppressed at the top of `cli.tsx`
  (`AI_SDK_LOG_WARNINGS = false`); anything written to stderr tears the UI.
- Sessions, memory, and history live under `~/.shiro-neko/`, relocatable with `SHIRO_HOME`;
  tests depend on that env var to isolate state. Don't resolve the path eagerly at module load —
  `store.ts` resolves it per call for this reason.
- Release tags must match `src/version.ts` exactly or `release.ts` stops the build.
