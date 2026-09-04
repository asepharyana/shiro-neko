import ts from 'typescript';
import { join, relative, dirname, extname } from 'node:path';
import { statSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

// ── Types ──────────────────────────────────────────────────────────────────────

export type FileKind = 'source' | 'test' | 'config' | 'other';

export type FileNode = {
  path: string;          // relative to root
  kind: FileKind;
  imports: string[];     // relative paths of imported modules
  exports: string[];     // exported names
  types: string[];       // exported type/interface names
  classes: string[];     // exported class names
  functions: string[];   // exported function names
  size: number;          // estimated LOC
  description?: string;  // first JSDoc or line comment, for the summary
};

export type CodeGraph = {
  version: 1;
  generated: string;     // ISO timestamp
  root: string;          // project root
  entryPoints: string[];
  files: Record<string, FileNode>;
  moduleMap: Record<string, string[]>;  // dir → file paths
  circularDeps: string[][];             // cycles detected
  summary: string;       // compact text for system prompt
};

// ── Constants ──────────────────────────────────────────────────────────────────

const GRAPH_DIR = '.shiro';
const GRAPH_FILE = 'codegraph.json';
const MAX_SUMMARY_FILES = 200;  // truncate summary for huge codebases
const MAX_SUMMARY_MODULES = 30;

// ── File discovery ─────────────────────────────────────────────────────────────

function classifyFile(relPath: string): FileKind {
  // Only match actual test files: *.test.ts, *.spec.ts, or test/*.{ts,tsx}
  // but NOT test helpers or fixtures inside test/
  if (/\.(test|spec)\.(ts|tsx)$/.test(relPath)) return 'test';
  if (relPath.startsWith('test/') && !relPath.includes('helpers') && !relPath.includes('fixtures')) return 'test';
  if (relPath === 'tsconfig.json' || relPath === 'package.json' ||
      relPath.endsWith('.config.ts') || relPath.endsWith('.config.js') ||
      relPath.startsWith('.shiro/')) return 'config';
  if (/\.(ts|tsx)$/.test(relPath)) return 'source';
  return 'other';
}

function walkFiles(root: string, dir: string, acc: string[]): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === '.next') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(root, full, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      acc.push(full);
    }
  }
}

// ── TypeScript analysis ────────────────────────────────────────────────────────

function createProgram(root: string): ts.Program {
  // Try reading tsconfig.json for options
  const tsconfigPath = join(root, 'tsconfig.json');
  let compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: false,
    strict: false,
    skipLibCheck: true,
    noEmit: true,
  };
  let rootFileNames: string[] = [];

  if (existsSync(tsconfigPath)) {
    try {
      const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
      if (!configFile.error) {
        const parsed = ts.parseJsonConfigFileContent(
          configFile.config,
          ts.sys,
          root,
        );
        compilerOptions = { ...compilerOptions, ...parsed.options };
        rootFileNames = parsed.fileNames.filter((f) => /\.(ts|tsx)$/.test(f));
      }
    } catch {
      // Fall back to defaults
    }
  }

  if (rootFileNames.length === 0) {
    // Walk manually
    const files: string[] = [];
    walkFiles(root, root, files);
    rootFileNames = files;
  }

  return ts.createProgram(rootFileNames, compilerOptions);
}

function analyzeFile(sourceFile: ts.SourceFile, program: ts.Program, root: string, absPath: string): FileNode {
  const relPath = relative(root, absPath);
  const kind = classifyFile(relPath);
  const sourceFileText = sourceFile.getFullText();
  const size = sourceFileText.split('\n').length;

  const imports: string[] = [];
  const exports: string[] = [];
  const types: string[] = [];
  const classes: string[] = [];
  const functions: string[] = [];

  ts.forEachChild(sourceFile, (node) => {
    // Import declarations
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      // Only track relative imports (same project)
      if (specifier.startsWith('.')) {
        const resolved = resolveRelativePath(absPath, specifier, root);
        if (resolved) imports.push(resolved);
      }
    }

    // Export declarations (re-exports, including export * from)
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        if (specifier.startsWith('.')) {
          const resolved = resolveRelativePath(absPath, specifier, root);
          if (resolved) imports.push(resolved);
        }
        // Named exports from re-exports
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const el of node.exportClause.elements) {
            exports.push(el.name.text);
          }
        }
        // export * from './foo' — no exportClause, but moduleSpecifier present
        // This is a dependency edge even though no names are imported.
      }
    }

    // Export assignments (export default ...)
    if (ts.isExportAssignment(node)) {
      exports.push('default');
    }

    // Exported declarations
    const isExported = (n: ts.Node): boolean => {
      if (!ts.canHaveModifiers(n)) return false;
      const mods = ts.getModifiers(n as ts.HasModifiers);
      return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    };

    // Interface declarations (only count as export if the keyword is present)
    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.text;
      if (isExported(node)) {
        exports.push(name);
        types.push(name);
      }
    }

    // Type alias declarations
    if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.text;
      if (isExported(node)) {
        exports.push(name);
        types.push(name);
      }
    }

    // Class declarations
    if (ts.isClassDeclaration(node) && node.name) {
      const name = node.name.text;
      if (isExported(node)) {
        exports.push(name);
        classes.push(name);
      }
    }

    // Function declarations
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      if (isExported(node)) {
        exports.push(name);
        functions.push(name);
      }
    }

    // Variable declarations (export const, export let)
    if (ts.isVariableStatement(node) && isExported(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          exports.push(decl.name.text);
        }
      }
    }
  });

  return {
    path: relPath,
    kind,
    imports,
    exports: [...new Set(exports)],
    types: [...new Set(types)],
    classes: [...new Set(classes)],
    functions: [...new Set(functions)],
    size,
    description: extractDescription(sourceFileText),
  };
}

/**
 * Extract the first JSDoc comment or line comment from the TOP of a source file
 * (before the first import). Used for the compact summary so the agent knows
 * what each file is about without reading it.
 */
function extractDescription(text: string): string | undefined {
  // Only look at text BEFORE the first import statement — that's where
  // file-level JSDoc or comments live. Anything after is per-constant/function.
  const firstImportIdx = text.search(/^import\b/m);
  const head = firstImportIdx >= 0 ? text.slice(0, firstImportIdx) : text.split('\n').slice(0, 30).join('\n');

  // Try JSDoc first: /** ... */
  const jsdocMatch = head.match(/\/\*\*\s*\n?\s*\*\s*(.+?)(?:\n|\*\/)/);
  if (jsdocMatch) return jsdocMatch[1]?.trim();

  // Then line comments: // ...
  const lineMatch = head.match(/^\/\/\s*(.+)$/m);
  if (lineMatch) return lineMatch[1]?.trim();

  return undefined;
}

function resolveRelativePath(fromFile: string, specifier: string, root: string): string | null {
  const dir = dirname(fromFile);
  let candidate = join(dir, specifier);

  // Try common extensions
  const exts = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx'];
  if (existsSync(candidate) && statSync(candidate).isFile()) {
    return relative(root, candidate);
  }
  for (const ext of exts) {
    const withExt = candidate + ext;
    if (existsSync(withExt)) {
      return relative(root, withExt);
    }
  }
  return null;
}

// ── Graph building ─────────────────────────────────────────────────────────────

function detectCircularDeps(files: Record<string, FileNode>): string[][] {
  const rawCycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): void {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      if (cycleStart >= 0) {
        rawCycles.push([...path.slice(cycleStart), node]);
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    const file = files[node];
    if (file) {
      for (const imp of file.imports) {
        if (files[imp]) dfs(imp);
      }
    }

    path.pop();
    inStack.delete(node);
  }

  for (const key of Object.keys(files)) {
    dfs(key);
  }

  // Deduplicate: A→B→C→A and B→C→A→B are the same cycle.
  // Use the lexicographically smallest node as canonical start.
  const seen = new Set<string>();
  const unique: string[][] = [];
  for (const cycle of rawCycles) {
    const nodes = cycle.slice(0, -1); // remove trailing duplicate start
    if (nodes.length === 0) continue;
    let minIdx = 0;
    for (let i = 1; i < nodes.length; i++) {
      if (nodes[i]! < nodes[minIdx]!) minIdx = i;
    }
    const canonical = [...nodes.slice(minIdx), ...nodes.slice(0, minIdx), nodes[minIdx]!];
    const key = canonical.join('→');
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(canonical);
    }
  }
  return unique;
}

function detectEntryPoints(files: Record<string, FileNode>): string[] {
  // Build fan-in (how many files import this one) and fan-out (how many this imports)
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();

  for (const [path, node] of Object.entries(files)) {
    fanOut.set(path, node.imports.length);
    for (const imp of node.imports) {
      fanIn.set(imp, (fanIn.get(imp) ?? 0) + 1);
    }
  }

  const candidates: { path: string; score: number }[] = [];

  for (const [path, node] of Object.entries(files)) {
    if (node.kind !== 'source') continue;

    const out = fanOut.get(path) ?? 0;
    const in_ = fanIn.get(path) ?? 0;
    let score = 0;

    // High fan-out + low fan-in = entry point (imports many, imported by few)
    if (out >= 8 && in_ <= 1) score += 4;
    else if (out >= 5 && in_ <= 2) score += 3;
    else if (out >= 3 && in_ === 0) score += 2;

    // CLI-like names
    if (path.startsWith('cli') || path.includes('main') || path.includes('index')) score += 2;

    // Files with main/run/start functions
    if (node.functions.includes('main') || node.functions.includes('run') || node.functions.includes('start')) {
      score += 3;
    }

    // Shebang line = program entry
    // (can't check sourceFile text here, but cli.* is already rewarded)

    if (score >= 3) {
      candidates.push({ path, score });
    }
  }

  return candidates.sort((a, b) => b.score - a.score).map((c) => c.path).slice(0, 5);
}

/**
 * Build a centrality list: files ranked by how many other files import them.
 * High fan-in = core/dependency. Low fan-in + high fan-out = entry point.
 */
function buildCentrality(files: Record<string, FileNode>): { path: string; fanIn: number; fanOut: number }[] {
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();

  for (const [path, node] of Object.entries(files)) {
    fanOut.set(path, node.imports.length);
    for (const imp of node.imports) {
      fanIn.set(imp, (fanIn.get(imp) ?? 0) + 1);
    }
  }

  return Object.keys(files)
    .map((path) => ({ path, fanIn: fanIn.get(path) ?? 0, fanOut: fanOut.get(path) ?? 0 }))
    .sort((a, b) => b.fanIn - a.fanIn);
}

function buildModuleMap(files: Record<string, FileNode>): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const path of Object.keys(files)) {
    const dir = dirname(path);
    if (!map[dir]) map[dir] = [];
    map[dir].push(path);
  }
  return map;
}

function summarizeGraph(graph: Omit<CodeGraph, 'summary'>): string {
  const lines: string[] = [];
  lines.push(`Codebase Architecture (${graph.root})`);
  lines.push('');

  // Entry points
  if (graph.entryPoints.length > 0) {
    lines.push(`Entry: ${graph.entryPoints.join(', ')}`);
  }

  // Module summary
  const dirs = Object.keys(graph.moduleMap).sort();
  const sourceDirs = dirs.filter((d) =>
    graph.moduleMap[d]?.some((f) => graph.files[f]?.kind === 'source') ?? false
  );

  lines.push(`Modules (${sourceDirs.length}):`);
  for (const dir of sourceDirs.slice(0, MAX_SUMMARY_MODULES)) {
    const sourceFiles = (graph.moduleMap[dir] ?? []).filter((f) => graph.files[f]?.kind === 'source');
    if (sourceFiles.length === 0) continue;
    const names = sourceFiles
      .map((f) => {
        const name = f.split('/').pop()?.replace(/\.(ts|tsx)$/, '') ?? f;
        return name;
      })
      .slice(0, 8);
    const more = sourceFiles.length > 8 ? ` +${sourceFiles.length - 8}` : '';
    lines.push(`  ${dir || '.'} → ${sourceFiles.length} files: ${names.join(', ')}${more}`);
  }

  // Key types (only the most frequently referenced)
  const allTypes = new Map<string, number>();
  for (const node of Object.values(graph.files)) {
    for (const t of node.types) {
      allTypes.set(t, (allTypes.get(t) ?? 0) + 1);
    }
  }
  if (allTypes.size > 0) {
    const topTypes = [...allTypes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name]) => name);
    lines.push(`Key types: ${topTypes.join(', ')}`);
  }

  // Core files (most imported by others)
  const centrality = buildCentrality(graph.files);
  const coreFiles = centrality.filter((c) => c.fanIn >= 2).slice(0, 6);
  if (coreFiles.length > 0) {
    lines.push(`Core (most imported):`);
    for (const c of coreFiles) {
      const node = graph.files[c.path];
      const desc = node?.description ? ` — ${node.description}` : '';
      lines.push(`  ${c.path} (${c.fanIn}x imported, ${c.fanOut} imports)${desc}`);
    }
  }

  // File descriptions for key source files (non-test, non-config)
  const described = Object.values(graph.files)
    .filter((f) => f.kind === 'source' && f.description && f.imports.length >= 3)
    .sort((a, b) => b.size - a.size)
    .slice(0, 8);
  if (described.length > 0) {
    lines.push(`Key files:`);
    for (const f of described) {
      lines.push(`  ${f.path}: ${f.description}`);
    }
  }

  // Circular deps
  if (graph.circularDeps.length > 0) {
    lines.push(`Circular deps: ${graph.circularDeps.length}`);
    for (const cycle of graph.circularDeps.slice(0, 3)) {
      lines.push(`  ${cycle.join(' → ')}`);
    }
  } else {
    lines.push('Circular deps: none');
  }

  // Size
  const totalLoc = Object.values(graph.files).reduce((s, f) => s + f.size, 0);
  lines.push(`Total: ${Object.keys(graph.files).length} source files, ~${totalLoc.toLocaleString()} LOC`);

  return lines.join('\n');
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Build a code graph from static analysis of a TypeScript project.
 *
 * Uses the TypeScript compiler API for accurate import/export resolution.
 * The result includes a compact summary text suitable for injection into a
 * system prompt, so the agent knows the codebase architecture before it
 * makes a single tool call.
 */
export function scanCodebase(root: string): CodeGraph {
  const program = createProgram(root);
  const files: Record<string, FileNode> = {};

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    const absPath = sourceFile.fileName;
    // Skip files outside the root (e.g., node_modules)
    if (!absPath.startsWith(root)) continue;
    // Skip d.ts files
    if (absPath.endsWith('.d.ts')) continue;

    const node = analyzeFile(sourceFile, program, root, absPath);
    files[node.path] = node;
  }

  const entryPoints = detectEntryPoints(files);
  const moduleMap = buildModuleMap(files);
  const circularDeps = detectCircularDeps(files);

  const graph: Omit<CodeGraph, 'summary'> = {
    version: 1,
    generated: new Date().toISOString(),
    root: relative(process.cwd(), root) || '.',
    entryPoints,
    files,
    moduleMap,
    circularDeps,
  };

  return { ...graph, summary: summarizeGraph(graph) };
}

// ── Persistence ────────────────────────────────────────────────────────────────

function graphPath(root: string): string {
  return join(root, GRAPH_DIR, GRAPH_FILE);
}

export function loadGraph(root: string): CodeGraph | null {
  const path = graphPath(root);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw);
    if (data.version !== 1) return null;
    return data as CodeGraph;
  } catch {
    return null;
  }
}

export function saveGraph(root: string, graph: CodeGraph): void {
  const dir = join(root, GRAPH_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(graphPath(root), JSON.stringify(graph, null, 2));
}

/**
 * Returns true if the cached graph is still fresh (no source files have
 * been modified since it was generated). Checks ONLY the files already
 * in the graph — does not re-walk the directory tree.
 */
export function isGraphFresh(root: string, graph: CodeGraph): boolean {
  const generatedMs = new Date(graph.generated).getTime();
  try {
    for (const relPath of Object.keys(graph.files)) {
      const absPath = join(root, relPath);
      // File was deleted since the graph was built
      if (!existsSync(absPath)) return false;
      const mtime = statSync(absPath).mtimeMs;
      if (mtime > generatedMs) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Get or build the code graph. Returns cached version if fresh, otherwise
 * recomputes and persists.
 */
export function getCodeGraph(root: string, force?: boolean): CodeGraph {
  if (!force) {
    const cached = loadGraph(root);
    if (cached && isGraphFresh(root, cached)) return cached;
  }
  const graph = scanCodebase(root);
  saveGraph(root, graph);
  return graph;
}
