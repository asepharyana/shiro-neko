import { z } from 'zod';
import { join } from 'node:path';
import { getCodeGraph, type CodeGraph, type FileNode } from './codegraph';

/**
 * A tool that exposes the pre-computed codebase dependency graph.
 *
 * The graph is built once by static analysis (TypeScript compiler API) and
 * cached to `.shiro/codegraph.json`. This tool lets the agent query it
 * without re-reading files.
 */
export const codegraphQuerySchema = z.object({
  query: z
    .enum([
      'list', 'summary', 'file', 'deps', 'types', 'circular', 'entry',
      'impact', 'dead', 'tests', 'boundaries', 'depth', 'cycle-check',
    ])
    .describe(
      'list: all files; summary: architecture overview; file <path>: full info; ' +
      'deps <path>: imports and reverse-deps; types: all exported types; ' +
      'circular: circular chains; entry: entry points; ' +
      'impact <path>: all files transitively affected by changes to this file; ' +
      'dead: files never imported (potential dead code); ' +
      'tests <path>: which test files cover this source file; ' +
      'boundaries: module-to-module dependency summary; ' +
      'depth <path>: import chain depth from this file; ' +
      'cycle-check <path>: check if adding an import to <target> would create a cycle.',
    ),
  path: z
    .string()
    .optional()
    .describe('File path (relative or fuzzy). Required for path-based queries.'),
  target: z
    .string()
    .optional()
    .describe('Second file path. Required for cycle-check.'),
});

export type CodegraphQuery = z.infer<typeof codegraphQuerySchema>;

// ── Helpers ────────────────────────────────────────────────────────────────────

function resolveFile(graph: CodeGraph, input: string): string | null {
  if (graph.files[input]) return input;
  const matches = Object.keys(graph.files).filter((f) => f.includes(input));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    // Prefer source files over test/config when ambiguous
    const sources = matches.filter((f) => graph.files[f]?.kind === 'source');
    if (sources.length === 1) return sources[0]!;
    return null; // still ambiguous
  }
  return null; // not found
}

function resolveFileOrError(graph: CodeGraph, input: string | undefined, queryName: string): string | Error {
  if (!input) return new Error(`"${queryName}" query requires a path argument.`);
  const resolved = resolveFile(graph, input);
  if (!resolved) {
    const matches = Object.keys(graph.files).filter((f) => f.includes(input));
    if (matches.length > 1) return new Error(`Multiple matches: ${matches.join(', ')}. Be more specific.`);
    return new Error(`File not found: ${input}`);
  }
  return resolved;
}

function formatFileNode(graph: CodeGraph, relPath: string): string {
  const node = graph.files[relPath];
  if (!node) return `File not found: ${relPath}`;

  const lines: string[] = [];
  lines.push(`${node.path} (${node.kind}, ~${node.size} LOC)`);
  if (node.description) lines.push(`  description: ${node.description}`);
  if (node.imports.length > 0) lines.push(`  imports: ${node.imports.join(', ')}`);
  if (node.exports.length > 0) lines.push(`  exports: ${node.exports.join(', ')}`);
  if (node.types.length > 0) lines.push(`  types: ${node.types.join(', ')}`);
  if (node.classes.length > 0) lines.push(`  classes: ${node.classes.join(', ')}`);
  if (node.functions.length > 0) lines.push(`  functions: ${node.functions.join(', ')}`);
  return lines.join('\n');
}

function findReverseDeps(graph: CodeGraph, targetPath: string): string[] {
  return Object.entries(graph.files)
    .filter(([_, node]) => node.imports.includes(targetPath))
    .map(([path]) => path);
}

/** Transitive reverse dependencies — all files that (directly or indirectly) import target. */
function transitiveReverseDeps(graph: CodeGraph, target: string): string[] {
  const result = new Set<string>();
  const queue = [target];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const [path, node] of Object.entries(graph.files)) {
      if (node.imports.includes(current) && !result.has(path)) {
        result.add(path);
        queue.push(path);
      }
    }
  }
  return [...result].sort();
}

/** Transitive forward dependencies — all files this file (directly or indirectly) imports. */
function transitiveForwardDeps(graph: CodeGraph, start: string): string[] {
  const result = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const node = graph.files[current];
    if (!node) continue;
    for (const imp of node.imports) {
      if (!result.has(imp)) {
        result.add(imp);
        queue.push(imp);
      }
    }
  }
  return [...result].sort();
}

// ── Query handlers ─────────────────────────────────────────────────────────────

function handleImpact(graph: CodeGraph, input: string | undefined): string {
  const resolved = resolveFileOrError(graph, input, 'impact');
  if (resolved instanceof Error) return resolved.message;

  const affected = transitiveReverseDeps(graph, resolved);
  if (affected.length === 0) return `${resolved} is not imported by any other file. Changes here are self-contained.`;

  const lines: string[] = [];
  lines.push(`Impact of changing ${resolved} — ${affected.length} file(s) affected:`);

  // Group by kind
  const byKind: Record<string, string[]> = {};
  for (const f of affected) {
    const node = graph.files[f];
    const kind = node?.kind ?? 'other';
    if (!byKind[kind]) byKind[kind] = [];
    byKind[kind].push(f);
  }
  for (const [kind, files] of Object.entries(byKind)) {
    lines.push(`  ${kind}: ${files.join(', ')}`);
  }

  // Also show which test files are affected
  const testFiles = affected.filter((f) => graph.files[f]?.kind === 'test');
  if (testFiles.length > 0) {
    lines.push(`\nRun these tests to verify: ${testFiles.join(', ')}`);
  }

  return lines.join('\n');
}

function handleDead(graph: CodeGraph): string {
  // Build fan-in map
  const fanIn = new Map<string, number>();
  for (const node of Object.values(graph.files)) {
    for (const imp of node.imports) {
      fanIn.set(imp, (fanIn.get(imp) ?? 0) + 1);
    }
  }

  const entrySet = new Set(graph.entryPoints);
  const dead: { path: string; kind: string; size: number }[] = [];

  for (const [path, node] of Object.entries(graph.files)) {
    if (node.kind === 'test') continue; // test files are imported by test runners, not source
    if (node.kind === 'config') continue;
    if (entrySet.has(path)) continue;
    const in_ = fanIn.get(path) ?? 0;
    if (in_ === 0) {
      dead.push({ path, kind: node.kind, size: node.size });
    }
  }

  if (dead.length === 0) return 'No dead code detected. Every source file is imported by at least one other file.';

  const lines: string[] = [];
  lines.push(`Potential dead code — ${dead.length} file(s) never imported:`);
  for (const d of dead.sort((a, b) => b.size - a.size)) {
    lines.push(`  ${d.path} (${d.kind}, ~${d.size} LOC)`);
  }
  lines.push(`\nVerify these are truly unused before deleting. They may be dynamic imports, side-effect modules, or entry points not detected by static analysis.`);
  return lines.join('\n');
}

function handleTests(graph: CodeGraph, input: string | undefined): string {
  const resolved = resolveFileOrError(graph, input, 'tests');
  if (resolved instanceof Error) return resolved.message;

  // Find test files that import this file (directly or transitively)
  const testFiles = Object.entries(graph.files)
    .filter(([_, node]) => node.kind === 'test')
    .map(([path]) => path);

  const covering: string[] = [];
  for (const testFile of testFiles) {
    const deps = transitiveForwardDeps(graph, testFile);
    if (deps.includes(resolved)) {
      covering.push(testFile);
    }
  }

  if (covering.length === 0) return `No test files import ${resolved}. Consider adding test coverage.`;

  return `Test files covering ${resolved} (${covering.length}):\n${covering.map((f) => `  ${f}`).join('\n')}`;
}

function handleBoundaries(graph: CodeGraph): string {
  // Group files by top-level directory
  const modules: Record<string, string[]> = {};
  for (const path of Object.keys(graph.files)) {
    const parts = path.split('/');
    const mod = parts.length > 1 ? parts[0]! : '.';
    if (!modules[mod]) modules[mod] = [];
    modules[mod].push(path);
  }

  // Build module-level dependency matrix
  const modDeps: Record<string, Set<string>> = {};
  for (const [path, node] of Object.entries(graph.files)) {
    const srcParts = path.split('/');
    const srcMod = srcParts.length > 1 ? srcParts[0]! : '.';
    if (!modDeps[srcMod]) modDeps[srcMod] = new Set();
    for (const imp of node.imports) {
      const impParts = imp.split('/');
      const impMod = impParts.length > 1 ? impParts[0]! : '.';
      if (impMod !== srcMod) modDeps[srcMod].add(impMod);
    }
  }

  const lines: string[] = [];
  lines.push('Module boundaries:');
  for (const [mod, deps] of Object.entries(modDeps).sort(([a], [b]) => a.localeCompare(b))) {
    const fileCount = modules[mod]?.length ?? 0;
    if (deps.size === 0) {
      lines.push(`  ${mod}/ (${fileCount} files) → no outbound deps (leaf module)`);
    } else {
      lines.push(`  ${mod}/ (${fileCount} files) → ${[...deps].join(', ')}`);
    }
  }

  // Check for violations: does a "lower" module import from a "higher" one?
  // Heuristic: test should not be imported by src, ui should not be imported by core
  const violations: string[] = [];
  for (const [srcMod, deps] of Object.entries(modDeps)) {
    for (const depMod of deps) {
      if (srcMod === 'src' && depMod === 'test') violations.push(`${srcMod}/ imports from ${depMod}/`);
      if (srcMod === 'src' && depMod === 'test') violations.push(`${srcMod}/ imports from ${depMod}/`);
    }
  }
  if (violations.length > 0) {
    lines.push(`\nPotential violations:`);
    for (const v of violations) lines.push(`  ⚠ ${v}`);
  }

  return lines.join('\n');
}

function handleDepth(graph: CodeGraph, input: string | undefined): string {
  const resolved = resolveFileOrError(graph, input, 'depth');
  if (resolved instanceof Error) return resolved.message;

  // BFS to find max depth
  const visited = new Map<string, number>();
  const queue: { path: string; depth: number }[] = [{ path: resolved, depth: 0 }];
  let maxDepth = 0;
  let deepestPath: string[] = [];

  while (queue.length > 0) {
    const { path, depth } = queue.shift()!;
    if (visited.has(path)) continue;
    visited.set(path, depth);
    if (depth > maxDepth) maxDepth = depth;

    const node = graph.files[path];
    if (!node) continue;
    for (const imp of node.imports) {
      if (!visited.has(imp)) {
        queue.push({ path: imp, depth: depth + 1 });
      }
    }
  }

  // Find the deepest chain
  const findDeepest = (start: string, depth: number, path: string[]): string[] => {
    const node = graph.files[start];
    if (!node || node.imports.length === 0) return path;
    let best = path;
    for (const imp of node.imports) {
      if (!visited.has(imp) || visited.get(imp)! <= depth) continue;
      const candidate = findDeepest(imp, depth + 1, [...path, imp]);
      if (candidate.length > best.length) best = candidate;
    }
    return best;
  };
  deepestPath = findDeepest(resolved, 0, [resolved]);

  const lines: string[] = [];
  lines.push(`Import depth from ${resolved}:`);
  lines.push(`  Max depth: ${maxDepth}`);
  lines.push(`  Total reachable: ${visited.size} file(s)`);
  if (deepestPath.length > 1) {
    lines.push(`  Deepest chain: ${deepestPath.join(' → ')}`);
  }

  // Advice
  if (maxDepth >= 6) {
    lines.push(`\n⚠ High depth (${maxDepth}). This file has a deep import chain — consider if all dependencies are necessary.`);
  } else if (maxDepth <= 2) {
    lines.push(`\n✓ Low depth (${maxDepth}). This file is close to the leaves — easy to test in isolation.`);
  }

  return lines.join('\n');
}

function handleCycleCheck(graph: CodeGraph, input: string | undefined, target: string | undefined): string {
  const resolved = resolveFileOrError(graph, input, 'cycle-check');
  if (resolved instanceof Error) return resolved.message;
  if (!target) return 'Error: "cycle-check" query requires a target argument (the file you want to import).';

  const targetResolved = resolveFile(graph, target);
  if (!targetResolved) return `Target file not found: ${target}`;

  if (resolved === targetResolved) return 'Cannot import self — that is always a cycle.';

  // Check: does target already transitively import the source? If so, adding source → target creates a cycle.
  const targetDeps = transitiveForwardDeps(graph, targetResolved);
  if (targetDeps.includes(resolved)) {
    // Find the chain
    const chain = findChain(graph, targetResolved, resolved);
    return `⚠ CYCLE DETECTED: Adding ${resolved} → ${targetResolved} would create a cycle.\n` +
      `Chain: ${resolved} → ${targetResolved} → ${chain.join(' → ')} → ${resolved}`;
  }

  // Also check if source already imports target (redundant)
  const sourceNode = graph.files[resolved];
  if (sourceNode?.imports.includes(targetResolved)) {
    return `${resolved} already imports ${targetResolved}. No change needed.`;
  }

  return `✓ No cycle. Adding ${resolved} → ${targetResolved} is safe.`;
}

/** Find a path from `from` to `to` in the dependency graph. */
function findChain(graph: CodeGraph, from: string, to: string): string[] {
  const visited = new Set<string>();
  const queue: { path: string[] }[] = [{ path: [from] }];

  while (queue.length > 0) {
    const { path } = queue.shift()!;
    const current = path[path.length - 1]!;
    if (current === to) return path.slice(1, -1); // exclude start and end
    if (visited.has(current)) continue;
    visited.add(current);

    const node = graph.files[current];
    if (!node) continue;
    for (const imp of node.imports) {
      if (!visited.has(imp)) {
        queue.push({ path: [...path, imp] });
      }
    }
  }
  return [];
}

// ── Main dispatcher ────────────────────────────────────────────────────────────

export function executeCodegraphQuery(
  query: CodegraphQuery,
  rootDir: string,
): string {
  const graph = getCodeGraph(rootDir);

  switch (query.query) {
    case 'list': {
      const entries = Object.values(graph.files)
        .map((f) => `${f.path} (${f.kind}, ~${f.size} LOC)`)
        .join('\n');
      return `Files (${Object.keys(graph.files).length}):\n${entries}`;
    }

    case 'summary':
      return graph.summary;

    case 'file': {
      const resolved = resolveFileOrError(graph, query.path, 'file');
      if (resolved instanceof Error) return resolved.message;
      return formatFileNode(graph, resolved);
    }

    case 'deps': {
      const resolved = resolveFileOrError(graph, query.path, 'deps');
      if (resolved instanceof Error) return resolved.message;
      const node = graph.files[resolved]!;
      const reverse = findReverseDeps(graph, resolved);
      const lines: string[] = [];
      lines.push(`${resolved} imports ${node.imports.length} file(s):`);
      for (const imp of node.imports) lines.push(`  → ${imp}`);
      lines.push(`\nImported by ${reverse.length} file(s):`);
      for (const rev of reverse) lines.push(`  ← ${rev}`);
      return lines.join('\n');
    }

    case 'types': {
      const allTypes: { name: string; file: string }[] = [];
      for (const node of Object.values(graph.files)) {
        for (const t of node.types) {
          allTypes.push({ name: t, file: node.path });
        }
      }
      if (allTypes.length === 0) return 'No exported types found.';
      return allTypes.map((t) => `${t.name} ← ${t.file}`).join('\n');
    }

    case 'circular': {
      if (graph.circularDeps.length === 0) return 'No circular dependencies detected.';
      return graph.circularDeps.map((cycle) => cycle.join(' → ')).join('\n\n');
    }

    case 'entry': {
      if (graph.entryPoints.length === 0) return 'No entry points detected.';
      return graph.entryPoints.map((ep) => {
        const node = graph.files[ep];
        if (!node) return ep;
        return `${ep} (${node.functions.length} exports, ${node.imports.length} imports)`;
      }).join('\n');
    }

    case 'impact':
      return handleImpact(graph, query.path);

    case 'dead':
      return handleDead(graph);

    case 'tests':
      return handleTests(graph, query.path);

    case 'boundaries':
      return handleBoundaries(graph);

    case 'depth':
      return handleDepth(graph, query.path);

    case 'cycle-check':
      return handleCycleCheck(graph, query.path, query.target);
  }
}

/**
 * The codegraph tool definition.
 */
export const codegraphTool = {
  name: 'codegraph',
  description: 'Query the pre-computed codebase dependency graph. Build once via static analysis; queries are instant without reading files.',
  inputSchema: codegraphQuerySchema,
  execute: async (args: CodegraphQuery) => {
    const rootDir = process.cwd();
    return executeCodegraphQuery(args, rootDir);
  },
};
