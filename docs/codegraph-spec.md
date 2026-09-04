# Codebase Graph — Spec

## TL;DR
Static-analysis graph that scans a TypeScript project and injects a compact architecture overview into the system prompt, so the agent knows the codebase structure before making a single tool call.

## Problem
When a session starts in a large TS codebase, the agent has no idea what files exist, how they connect, or what the architecture is. It wastes 2-5 turns exploring (glob, grep, read_file) just to build a mental model. This is the "shiro-neko" problem: the agent should be a senior engineer who has read the codebase, not a newcomer who needs to explore first.

## Goal
- Compute a dependency graph of all .ts/.tsx files in the workspace via TypeScript compiler API
- Persist the graph to `.shiro/codegraph.json` (mtime-based freshness)
- Inject a compact "Codebase Architecture" section (~200-500 tokens) into the system prompt
- Provide a `codegraph` tool for detailed queries (file deps, type refs, circular deps, etc.)
- Add a `/graph` command to force regeneration

## Architecture

### Data model (src/codegraph.ts)

```ts
type FileNode = {
  path: string;           // relative to root
  kind: 'source' | 'test' | 'config' | 'other';
  imports: string[];      // file-relative paths
  exports: string[];      // exported names
  types: string[];        // exported type/interface names
  classes: string[];      // exported class names
  functions: string[];    // exported function names
  size: number;           // estimated LOC
};

type CodeGraph = {
  version: 1;
  generated: string;      // ISO timestamp
  root: string;           // project root
  entryPoints: string[];  // files with main() or re-export patterns
  files: Record<string, FileNode>;
  moduleMap: Record<string, string[]>;  // dir → files
  circularDeps: string[][];             // cycles
  summary: string;        // compact text for system prompt
};
```

### Static analysis approach

Use TypeScript `createProgram` to:
1. Read `tsconfig.json` (if exists) for compiler options + include patterns
2. Create a program with all source files
3. For each source file:
   - Walk `ImportDeclaration` nodes → extract resolved file paths
   - Walk `ExportDeclaration` nodes → extract exported names
   - Walk `InterfaceDeclaration`, `TypeAliasDeclaration` → exported types
   - Walk `ClassDeclaration` → exported classes
   - Walk `FunctionDeclaration` → exported functions
4. Build the dependency graph
5. Detect circular dependencies via DFS
6. Classify files: source (src/), test (test/, *.test.ts), config (tsconfig, package.json), other
7. Detect entry points: files in `src/` that import fewest others (leaf-ward), or contain `main()`/`export default`
8. Generate compact summary text

### Summary text format

```
Codebase Architecture (shiro-neko)
Entry: src/cli.tsx (CLI entry, loads everything)
Modules (6):
  src/     → 13 files: session, tools, prompt, config, cli, subagent, memory, commands, agents, notebook, prune, pricing, store
  src/ui/  → 4 files: App, ChatMessage, Thinking, BusyIndicator
  src/tools-* → 4 files: git, net, mcp, memory (tool implementations)
  test/    → 22 files
Key abstractions: Session (core), Notebook (task state), Permission (access), Undo (rollback)
Circular deps: none
```

### System prompt integration (prompt.ts)

New `PromptParts` field: `codegraph?: string`

Section placement: after "Environment", before "Tools available":
```
Codebase Architecture
${codegraph}
```

Only shown when graph is available (non-empty). Omitted when workspace has no .ts files.

### Session lifecycle (session.ts)

On `systemFor()` call:
1. Check `.shiro/codegraph.json` existence + freshness
2. Freshness: recompute if any .ts file in workspace has mtime > graph.generated
3. Cache in Session (don't recompute per-step)
4. Pass `PromptParts.codegraph` only when variant is non-empty (not in headless one-shot)

### Tool: codegraph

```ts
{
  name: 'codegraph',
  description: 'Query the pre-computed codebase dependency graph.',
  input: {
    query: 'list' | 'file <path>' | 'deps <path>' | 'types' | 'circular',
  },
}
```

- `list`: all files with kind + size
- `file <path>`: full info for one file
- `deps <path>`: what it imports and what imports it (reverse deps)
- `types`: all exported types/interfaces across codebase
- `circular`: all detected circular dependency chains

### Command: /graph

Forces regeneration of the codegraph. Shows the summary output in chat.

## Files touched

- **NEW**: `src/codegraph.ts` — core static analysis
- **NEW**: `src/tools-codegraph.ts` — tool definition
- **NEW**: `test/codegraph.test.ts` — tests
- **EDIT**: `src/prompt.ts` — add `codegraph?: string` to PromptParts, inject section
- **EDIT**: `src/session.ts` — compute/load graph in systemFor(), pass to PromptParts
- **EDIT**: `src/cli.tsx` — register codegraph tool, compute on startup
- **EDIT**: `src/commands.ts` — add `/graph` command
- **EDIT**: `src/ui/App.tsx` — handle `/graph` command
- **NEW**: `docs/codegraph.md` — user-facing documentation

## Verification

1. `bun run typecheck` — clean
2. `bun test` — all existing + new codegraph tests pass
3. `bun test test/codegraph.test.ts` — standalone codegraph verification
4. `bun run build` — binary compiles
5. Manual: start session in shiro-neko repo → system prompt includes architecture section
6. `/graph` regenerates and shows summary
7. `codegraph types` tool lists all exported types
8. Circular deps detected if they exist (none expected in shiro-neko itself)

## Edge cases

- **Empty workspace**: graph is empty, summary section omitted from prompt
- **Huge codebase (>500 files)**: summary truncated to top modules, tool provides full detail
- **No tsconfig.json**: fall back to default compiler options + all .ts files in CWD
- **Circular deps**: detected, listed in summary, queryable via tool
- **Freshness**: file mtime check on each session start; too slow? add a `--no-graph` flag
