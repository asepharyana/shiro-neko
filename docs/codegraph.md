# Codebase Graph

A pre-computed dependency graph built via static analysis (TypeScript compiler API).
It gives the agent an immediate map of the codebase at session start — no exploration turns needed.

## How it works

When a session starts, shiro-neko scans all `.ts`/`.tsx` files using the TypeScript
compiler API. It resolves imports, exports, types, classes, and functions, and
builds a directed dependency graph. The result is cached to `.shiro/codegraph.json`.

On subsequent sessions, if no source files have changed (mtime check), the cached
graph is reused. This means the system prompt includes the architecture overview
from the very first turn.

## What it contains

- **Entry points**: files the graph identifies as starting points (few imports, `main()` export, CLI-like)
- **Module map**: directory → file count → key file names
- **Key types**: the most frequently defined exported types/interfaces
- **Circular dependencies**: any cycles detected in the import graph
- **Total LOC**: total lines across all source files

## System prompt integration

The graph summary appears in the system prompt as a "Codebase Architecture" section,
right after the Environment block and before Tools. This means the agent knows the
project structure before making a single tool call.

## Querying the graph

Use the `codegraph` tool for detailed queries:

- `codegraph query: 'summary'` — the same overview in the system prompt
- `codegraph query: 'list'` — all files with kind and LOC
- `codegraph query: 'file', path: 'src/session.ts'` — detailed info for one file
- `codegraph query: 'deps', path: 'session'` — what it imports and what imports it
- `codegraph query: 'types'` — all exported types across the codebase
- `codegraph query: 'circular'` — circular dependency chains
- `codegraph query: 'entry'` — detected entry points

## Commands

`/graph` — force-regenerate the graph and show the summary.

## Architecture decisions

- **TypeScript compiler API** over regex parsing: handles re-exports, type-only imports,
  and module resolution correctly. Falls back to manual file walk if no tsconfig.json exists.
- **Mtime-based freshness**: recompute only when a source file has been modified since the
  graph was generated. The check walks all source files (same as the scan) — for huge
  codebases, add a `--no-graph` flag to skip.
- **Lazy computation**: the graph is computed once per session, not per step. The `Session`
  caches it in a field and the prompt is built from it.
- **Graceful fallback**: non-TypeScript projects, unreadable directories, or scan failures
  silently omit the section from the prompt rather than breaking the session.
