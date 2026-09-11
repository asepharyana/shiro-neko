import { tool } from 'ai';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { jail, posix, walk } from './ignore';
import { recordBeforeWrite } from './snapshot';
import { withMeta } from './tool-utils';
import { git } from './tools-git';

/**
 * The second batch of built-in tools, kept out of tools.ts so that file stays
 * reviewable. Four families:
 *
 *   edit      precise line-level edits that need no full-file rewrite
 *   inspect   filesystem navigation and metadata
 *   git ext   read-only git queries beyond the core five (argv-spawned, no shell)
 *   code      structured reads of source and environment
 *
 * Every write goes through `jail`, every read honours .gitignore through `walk`,
 * and every git call spawns the binary with a fixed argv — the same rules as the
 * core tools, so the approval and guard model needs nothing new.
 */

const MAX_OUTPUT = 30_000;
const cap = (s: string) =>
  s.length <= MAX_OUTPUT ? s : `${s.slice(0, MAX_OUTPUT)}\n... [truncated ${s.length - MAX_OUTPUT} chars]`;

const lines = (text: string) => text.split('\n');

async function readLines(path: string): Promise<{ abs: string; lines: string[] }> {
  const abs = jail(path);
  const file = Bun.file(abs);
  if (!(await file.exists())) throw new Error(`No such file: ${path}`);
  return { abs, lines: lines(await file.text()) };
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

export const insertLinesTool = withMeta({ set: 'extra', mutating: true }, tool({
  description:
    'Insert lines at a 1-based position in a file, pushing the rest down. Cheaper and safer than a rewrite for adding a block in the middle.',
  inputSchema: z.object({
    path: z.string(),
    line: z.number().int().min(1).describe('Insert before this 1-based line; one past the end appends'),
    text: z.string().describe('The lines to insert'),
  }),
  execute: async ({ path, line, text }) => {
    const { abs, lines: cur } = await readLines(path);
    await recordBeforeWrite(abs);
    if (line > cur.length + 1) throw new Error(`line ${line} is past the end of ${path} (${cur.length} lines)`);
    cur.splice(line - 1, 0, ...lines(text));
    await Bun.write(abs, cur.join('\n'));
    return `Inserted ${lines(text).length} line(s) at ${path}:${line}`;
  },
}));

export const deleteLinesTool = withMeta({ set: 'extra', mutating: true }, tool({
  description: 'Delete an inclusive range of lines from a file. Refuses to delete the whole file; use delete_file for that.',
  inputSchema: z.object({
    path: z.string(),
    start: z.number().int().min(1),
    end: z.number().int().min(1),
  }),
  execute: async ({ path, start, end }) => {
    if (end < start) throw new Error('end must be >= start');
    const { abs, lines: cur } = await readLines(path);
    await recordBeforeWrite(abs);
    if (end > cur.length) throw new Error(`end ${end} is past the end of ${path} (${cur.length} lines)`);
    if (start === 1 && end === cur.length) throw new Error('that deletes the whole file; use delete_file instead');
    cur.splice(start - 1, end - start + 1);
    await Bun.write(abs, cur.join('\n'));
    return `Deleted lines ${start}-${end} from ${path}`;
  },
}));

export const replaceLinesTool = withMeta({ set: 'extra', mutating: true }, tool({
  description: 'Replace an inclusive range of lines with new text, in one write.',
  inputSchema: z.object({
    path: z.string(),
    start: z.number().int().min(1),
    end: z.number().int().min(1),
    text: z.string().describe('Replacement content for the range'),
  }),
  execute: async ({ path, start, end, text }) => {
    if (end < start) throw new Error('end must be >= start');
    const { abs, lines: cur } = await readLines(path);
    await recordBeforeWrite(abs);
    if (end > cur.length) throw new Error(`end ${end} is past the end of ${path} (${cur.length} lines)`);
    cur.splice(start - 1, end - start + 1, ...lines(text));
    await Bun.write(abs, cur.join('\n'));
    return `Replaced lines ${start}-${end} in ${path}`;
  },
}));

export const appendFileTool = withMeta({ set: 'extra', mutating: true }, tool({
  description: 'Append text to the end of a file without reading the whole thing into the edit.',
  inputSchema: z.object({ path: z.string(), text: z.string() }),
  execute: async ({ path, text }) => {
    const { abs, lines: cur } = await readLines(path);
    await recordBeforeWrite(abs);
    await Bun.write(abs, `${cur.join('\n').replace(/\n?$/, '\n')}${text.replace(/\n?$/, '')}\n`);
    return `Appended ${lines(text).length} line(s) to ${path}`;
  },
}));

export const prependFileTool = withMeta({ set: 'extra', mutating: true }, tool({
  description: 'Prepend text to the start of a file, e.g. a license header or an import block.',
  inputSchema: z.object({ path: z.string(), text: z.string() }),
  execute: async ({ path, text }) => {
    const { abs, lines: cur } = await readLines(path);
    await recordBeforeWrite(abs);
    await Bun.write(abs, `${text.replace(/\n?$/, '\n')}${cur.join('\n')}`);
    return `Prepended ${lines(text).length} line(s) to ${path}`;
  },
}));

export const countLinesTool = withMeta({ set: 'extra', mutating: false }, tool({
  description: 'Count lines in one file, or per file across a glob. A quick size read before deciding to open something large.',
  inputSchema: z.object({
    path: z.string().optional().describe('One file. Omit to use pattern instead'),
    pattern: z.string().optional().describe('Glob, e.g. "src/**/*.ts", to count many files'),
  }),
  execute: async ({ path, pattern }) => {
    if (!path && !pattern) throw new Error('pass a path or a pattern');
    const out: string[] = [];
    const glob = pattern ? new Bun.Glob(pattern) : undefined;
    for await (const rel of walk({})) {
      if (path && rel !== posix(path)) continue;
      if (glob && !glob.match(rel)) continue;
      const abs = resolve(process.cwd(), rel);
      try {
        const n = (await Bun.file(abs).text()).split('\n').length;
        out.push(`${n}\t${rel}`);
      } catch {
        continue;
      }
      if (out.length >= 500) break;
    }
    return out.length ? cap(out.join('\n')) : 'No matching text files.';
  },
}));

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

const MAX_TREE = 400;

export const treeTool = withMeta({ set: 'extra', mutating: false }, tool({
  description:
    'Indented directory tree from a path, honouring .gitignore, with directories first. Faster to scan than list_dir for a broad shape.',
  inputSchema: z.object({
    path: z.string().optional().describe('Start directory, default the workspace root'),
    depth: z.number().int().min(1).max(6).optional().describe('Default 3'),
  }),
  execute: async ({ path = '.', depth = 3 }) => {
    const prefix = path === '.' ? '' : `${posix(path).replace(/\/$/, '')}/`;
    const rows: { rel: string; depth: number; dir: boolean }[] = [];
    for await (const rel of walk({})) {
      if (prefix && !rel.startsWith(prefix)) continue;
      const rest = prefix ? rel.slice(prefix.length) : rel;
      const parts = rest.split('/');
      if (parts.length > depth) continue;
      for (let d = 1; d <= parts.length; d++) {
        const ancestor = parts.slice(0, d).join('/');
        if (!rows.some((r) => r.rel === ancestor)) rows.push({ rel: ancestor, depth: d, dir: d < parts.length });
      }
      if (rows.length >= MAX_TREE) break;
    }
    rows.sort((a, b) => a.rel.localeCompare(b.rel));
    const out = rows.map((r) => `${'  '.repeat(r.depth - 1)}${r.rel.split('/').at(-1)}${r.dir ? '/' : ''}`);
    return out.length ? cap((prefix ? `${prefix.replace(/\/$/, '')}/\n` : './\n') + out.join('\n')) : `Nothing under ${path}.`;
  },
}));

export const fileInfoTool = withMeta({ set: 'extra', mutating: false }, tool({
  description: 'Metadata for one file: size, line count, modified time, and whether it is text or binary.',
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }) => {
    const abs = jail(path);
    let entry: Awaited<ReturnType<typeof stat>>;
    try {
      entry = await stat(abs);
    } catch {
      throw new Error(`No such file: ${path}`);
    }
    if (entry.isDirectory()) return `${path}: directory`;
    const bytes = new Uint8Array(await Bun.file(abs).slice(0, 8192).arrayBuffer());
    const binary = bytes.includes(0);
    const linesN = binary ? undefined : (await Bun.file(abs).text()).split('\n').length;
    return `${path}: ${entry.size} bytes${linesN === undefined ? '' : `, ${linesN} lines`}, ${binary ? 'binary' : 'text'}, modified ${entry.mtime.toISOString()}`;
  },
}));

export const findFilesTool = withMeta({ set: 'extra', mutating: false }, tool({
  description: 'Find files whose *name* contains a substring (not a glob), e.g. "auth" or ".test.". Honours .gitignore.',
  inputSchema: z.object({
    name: z.string().describe('Substring to match against the filename'),
    limit: z.number().int().min(1).optional().describe('Default 100'),
  }),
  execute: async ({ name, limit = 100 }) => {
    const needle = name.toLowerCase();
    const hits: string[] = [];
    for await (const rel of walk({})) {
      if ((rel.split('/').at(-1) ?? '').toLowerCase().includes(needle)) hits.push(rel);
      if (hits.length >= limit) break;
    }
    return hits.length ? cap(hits.join('\n')) : `No files matching "${name}".`;
  },
}));

export const recentFilesTool = withMeta({ set: 'extra', mutating: false }, tool({
  description: 'Files modified most recently, newest first. Orient in a tree you did not write, or find what a tool just touched.',
  inputSchema: z.object({ limit: z.number().int().min(1).optional().describe('Default 20') }),
  execute: async ({ limit = 20 }) => {
    const seen: { rel: string; mtime: number }[] = [];
    for await (const rel of walk({})) {
      try {
        const s = await stat(resolve(process.cwd(), rel));
        seen.push({ rel, mtime: s.mtimeMs });
      } catch {
        continue;
      }
    }
    seen.sort((a, b) => b.mtime - a.mtime);
    const out = seen.slice(0, limit).map((s) => `${new Date(s.mtime).toISOString().slice(0, 19).replace('T', ' ')}  ${s.rel}`);
    return out.length ? cap(out.join('\n')) : 'No files found.';
  },
}));

export const changedFilesTool = withMeta({ set: 'extra', mutating: false }, tool({
  description: 'Files git reports as modified, staged, or untracked — the working-tree delta at a glance, without a full status.',
  inputSchema: z.object({}),
  execute: async () => {
    const result = await git(['status', '--porcelain'], process.cwd());
    if (!result.ok) throw new Error(result.message);
    const out = result.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => `${l.slice(0, 2).trim() || ' '} ${posix(l.slice(3))}`);
    return out.length ? cap(out.join('\n')) : 'Working tree clean.';
  },
}));

// ---------------------------------------------------------------------------
// git ext (read-only, argv-spawned)
// ---------------------------------------------------------------------------

const gitRun = async (args: string[], empty: string): Promise<string> => {
  const result = await git(args, process.cwd());
  if (!result.ok) throw new Error(result.message);
  return cap(result.stdout.trim() || empty);
};

export const gitLogFileTool = withMeta({ set: 'extra', mutating: false }, tool({
  description: 'Commits that touched one file, newest first, with hash, date, and subject.',
  inputSchema: z.object({
    path: z.string(),
    limit: z.number().int().min(1).optional().describe('Default 15'),
  }),
  execute: async ({ path, limit = 15 }) =>
    gitRun(['log', `--max-count=${limit}`, '--pretty=format:%h %ad %s', '--date=short', '--', posix(path)], 'No history for that file.'),
}));

export const gitDiffCommitsTool = withMeta({ set: 'extra', mutating: false }, tool({
  description: 'Diff between two refs (branches, tags, or commits), optionally limited to one path.',
  inputSchema: z.object({
    from: z.string().describe('Base ref'),
    to: z.string().describe('Target ref'),
    path: z.string().optional().describe('Limit the diff to this file'),
  }),
  execute: async ({ from, to, path }) =>
    gitRun(['diff', `${from}...${to}`, ...(path ? ['--', posix(path)] : [])], `No differences between ${from} and ${to}.`),
}));

export const gitShowFileTool = withMeta({ set: 'extra', mutating: false }, tool({
  description: 'The contents of a file at a ref, e.g. what auth.ts looked like at HEAD~3 or on main.',
  inputSchema: z.object({
    ref: z.string().describe('Branch, tag, or commit'),
    path: z.string(),
  }),
  execute: async ({ ref, path }) => gitRun(['show', `${ref}:${posix(path)}`], `No ${path} at ${ref}.`),
}));

export const gitCurrentBranchTool = withMeta({ set: 'extra', mutating: false }, tool({
  description: 'The current branch, plus its upstream and ahead/behind count when one is set.',
  inputSchema: z.object({}),
  execute: async () => gitRun(['status', '--short', '--branch'], 'no commits yet'),
}));

export const gitChangedInRefTool = withMeta({ set: 'extra', mutating: false }, tool({
  description: 'Files changed between a ref and the working tree, name only.',
  inputSchema: z.object({ ref: z.string().describe('Compare the working tree against this ref, e.g. main') }),
  execute: async ({ ref }) => gitRun(['diff', '--name-only', ref], `No changes against ${ref}.`),
}));

// ---------------------------------------------------------------------------
// code
// ---------------------------------------------------------------------------

export const outlineTool = withMeta({ set: 'extra', mutating: false }, tool({
  description:
    'Top-level declarations of a source file — functions, classes, types, exports — as a compact structural map. Read this before opening a large file.',
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }) => {
    const abs = jail(path);
    const file = Bun.file(abs);
    if (!(await file.exists())) throw new Error(`No such file: ${path}`);
    const decl = /^\s*(export\s+(default\s+)?)?(async\s+)?(function|class|interface|type|enum|const|let|var|def|func|fn|struct|impl|trait|pub)\b/;
    const out: string[] = [];
    (await file.text()).split('\n').forEach((l, i) => {
      if (decl.test(l)) out.push(`${i + 1}: ${l.trim().slice(0, 120)}`);
    });
    return out.length ? cap(out.join('\n')) : `No top-level declarations found in ${path}.`;
  },
}));

export const readSymbolTool = withMeta({ set: 'extra', mutating: false }, tool({
  description: 'The full body of one top-level definition (function, class, type) from a file, by name.',
  inputSchema: z.object({
    path: z.string(),
    name: z.string().describe('The identifier to extract'),
  }),
  execute: async ({ path, name }) => {
    const abs = jail(path);
    const file = Bun.file(abs);
    if (!(await file.exists())) throw new Error(`No such file: ${path}`);
    const src = (await file.text()).split('\n');
    const start = src.findIndex((l) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(l) && !/^\s*(\/\/|#)/.test(l));
    if (start === -1) throw new Error(`No definition of "${name}" found in ${path}`);
    // Walk forward until the indentation returns to the declaration's level, which
    // is the end of the block for brace and indentation languages alike.
    const indent = /^(\s*)/.exec(src[start]!)![1]!.length;
    let end = start;
    for (let i = start + 1; i < src.length; i++) {
      const l = src[i]!;
      if (l.trim() === '') continue;
      if (/^(\s*)/.exec(l)![1]!.length <= indent && l.trim() !== '}' && l.trim() !== '};') break;
      end = i;
    }
    return cap(src.slice(start, end + 1).map((l, i) => `${start + i + 1}: ${l}`).join('\n'));
  },
}));

export const envInfoTool = withMeta({ set: 'extra', mutating: false }, tool({
  description: 'Platform, shell, runtimes, and package managers present, so commands are written for what is actually installed.',
  inputSchema: z.object({}),
  execute: async () => {
    const probe = async (bin: string, args: string[]) => {
      try {
        const proc = Bun.spawn([bin, ...args], { stdout: 'pipe', stderr: 'ignore' });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        return out.trim().split('\n')[0] ?? 'present';
      } catch {
        return undefined;
      }
    };
    const rows = [`platform: ${process.platform} ${process.arch}`, `cwd: ${process.cwd()}`];
    for (const [label, bin, args] of [
      ['node', 'node', ['--version']],
      ['bun', 'bun', ['--version']],
      ['git', 'git', ['--version']],
      ['npm', 'npm', ['--version']],
      ['python', 'python', ['--version']],
      ['rg', 'rg', ['--version']],
    ] as const) {
      const v = await probe(bin, [...args]);
      if (v) rows.push(`${label}: ${v}`);
    }
    return rows.join('\n');
  },
}));

export const countTokensTool = withMeta({ set: 'extra', mutating: false }, tool({
  description: 'Estimate the token cost of a file or a string before sending it to the model (~4 chars per token).',
  inputSchema: z.object({
    path: z.string().optional().describe('A file to measure'),
    text: z.string().optional().describe('Or a string to measure'),
  }),
  execute: async ({ path, text }) => {
    let content = text;
    if (content === undefined) {
      if (!path) throw new Error('pass a path or text');
      const abs = jail(path);
      const file = Bun.file(abs);
      if (!(await file.exists())) throw new Error(`No such file: ${path}`);
      content = await file.text();
    }
    const chars = content.length;
    return `${path ?? 'input'}: ${chars} chars, ~${Math.round(chars / 4)} tokens`;
  },
}));

export type CheckSuggestion = {
  name: string;
  command: string;
  source: string;
};

/**
 * The check commands a project documents, found the way a human would find them.
 *
 * AGENTS.md is the strongest source: it names the commands a cold agent should
 * run and usually the exact invocation. package.json scripts come next because
 * they are executable as-is (`test`, `typecheck`). After that the toolchain
 * itself says what "verify" means — `bun test` for a Bun project, `cargo test`
 * for Rust — so the fallback names a binary, not a guessed script.
 */
export async function docsCheckCommands(cwd: string): Promise<CheckSuggestion[]> {
  const out: CheckSuggestion[] = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md', '.shiro.md']) {
    const p = join(cwd, name);
    if (!(await Bun.file(p).exists())) continue;
    const text = await Bun.file(p).text();
    for (const raw of text.split('\n')) {
      const line = raw.trim().replace(/^\$\s*/, '');
      // A documented command. Take the first backticked span (the command),
      // else the whole line, so prose after the command never reaches the shell
      // — AGENTS.md content is not code, and `` `bun test` — desc `` would
      // otherwise run with the description attached.
      const backticked = /`([^`]+)`/.exec(line)?.[1];
      const candidate = (backticked ?? line).trim();
      const m = /^(bun|npm|npx|yarn|pnpm|cargo|go|python|pytest|ruby|make)\s+(\S.*)$/i.exec(candidate);
      if (!m) continue;
      const rest = m[2]!;
      if (!/\b(test|typecheck|type-check|check|lint|build|ci)\b/i.test(rest)) continue;
      const command = `${m[1]} ${rest}`.trim();
      out.push({ name: command.split(/\s+/).at(-1) ?? 'check', command, source: p });
    }
  }
  return out.slice(0, 10);
}

/**
 * Scripts declared in package.json, ordered the way a contributor reaches for
 * them: test, typecheck/check, lint, build, then the rest alphabetically.
 */
export async function manifestScripts(cwd: string): Promise<CheckSuggestion[]> {
  const p = join(cwd, 'package.json');
  if (!(await Bun.file(p).exists())) return [];
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(await Bun.file(p).text()) as { scripts?: Record<string, string> };
  } catch {
    return []; // a malformed manifest reports nothing rather than crashing the check
  }
  const scripts = pkg.scripts ?? {};
  // `bun run` when the project locks with bun, else `npm run` — the runner the
  // project's own lockfile says it uses.
  const runner = (await Bun.file(join(cwd, 'bun.lock')).exists()) || (await Bun.file(join(cwd, 'bun.lockb')).exists()) ? 'bun' : 'npm';
  const order = ['test', 'typecheck', 'check', 'lint', 'build'];
  const names = Object.keys(scripts).sort((a, b) => {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.localeCompare(b);
  });
  return names.map((n) => ({ name: n, command: `${runner} run ${n}`, source: p }));
}

/** Toolchain defaults: the binary that owns verification, when no manifest declares scripts. */
async function languageDefaults(cwd: string): Promise<CheckSuggestion[]> {
  const has = async (p: string) => Bun.file(join(cwd, p)).exists();
  if ((await has('bun.lock')) || (await has('package.json'))) {
    return [
      { name: 'test', command: 'bun test', source: 'bun.lock/package.json' },
      { name: 'typecheck', command: 'bun run typecheck', source: 'bun.lock/package.json' },
    ];
  }
  if (await has('Cargo.toml')) {
    return [
      { name: 'test', command: 'cargo test', source: 'Cargo.toml' },
      { name: 'build', command: 'cargo check', source: 'Cargo.toml' },
    ];
  }
  if (await has('go.mod')) {
    return [
      { name: 'test', command: 'go test ./...', source: 'go.mod' },
      { name: 'build', command: 'go build ./...', source: 'go.mod' },
    ];
  }
  if ((await has('pyproject.toml')) || (await has('requirements.txt')) || (await has('manage.py'))) {
    return [
      { name: 'test', command: 'python -m pytest', source: 'pyproject.toml/requirements.txt' },
      { name: 'typecheck', command: 'python -m mypy .', source: 'pyproject.toml/requirements.txt' },
    ];
  }
  return [];
}

/** Runs one check with a timeout via the platform shell, stdout+stderr merged, output capped. */
export async function runCheck(command: string, cwd: string, timeout: number): Promise<{ ok: boolean; output: string }> {
  const shell = process.platform === 'win32' ? ['cmd', '/c', command] : ['bash', '-lc', command];
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn(shell, { cwd, stdout: 'pipe', stderr: 'pipe', timeout });
  } catch {
    return { ok: false, output: `could not start: ${command}` };
  }
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  // Bun kills a timed-out process with SIGTERM; distinguishing that from a real
  // exit-143 matters because the model should retry differently (fix + rerun,
  // not debug a "failed" run that never actually failed).
  const timedOut = proc.signalCode !== null;
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n');
  if (timedOut) return { ok: false, output: cap(`timed out after ${timeout}ms (killed by SIGTERM)` + (output ? `\n${output}` : '')) };
  return { ok: code === 0, output: cap(output || `(no output, exit ${code})`) };
}

/**
 * The verification tool: run the project's own check commands and report
 * pass/fail with the first error.
 *
 * The system prompt already says "verify before done", but without a tool the
 * model invents the command — and `npm test` on a Bun project fails in a way
 * the model then has to debug. This finds the command the project documents
 * and runs it with a timeout, so one call answers "did my change break
 * anything", and the reply is PASS/FAIL plus the head of the output, not a
 * wall the model has to read.
 */
export const runChecksTool = withMeta({ set: 'extra', mutating: true }, tool({
  description:
    "Run the project's check commands (tests, typecheck, lint, build) and report pass/fail. " +
    'Detects them from AGENTS.md and package.json scripts automatically; pass target to run one named check. ' +
    'Prefer this over bash for verification — it finds the right command and caps the output.',
  inputSchema: z.object({
    target: z.string().optional().describe('A specific check to run: test, typecheck, lint, build, or a script name from package.json'),
    timeout: z.number().int().min(5_000).max(600_000).optional().describe('Per-command timeout in ms, default 120000'),
  }),
  execute: async ({ target, timeout = 120_000 }) => {
    const cwd = process.cwd();
    const all = [...(await docsCheckCommands(cwd)), ...(await manifestScripts(cwd)), ...(await languageDefaults(cwd))];
    if (all.length === 0) {
      return 'No check commands found (no AGENTS.md, package.json, or obvious toolchain). Run them yourself with bash.';
    }

    const wanted = target?.trim().toLowerCase();
    let picked: CheckSuggestion[];
    if (wanted) {
      picked = all.filter((s) => s.name.toLowerCase() === wanted);
      if (picked.length === 0) {
        return `No check named "${target}" — available: ${[...new Set(all.map((s) => s.name))].join(', ')}`;
      }
    } else {
      // Distinct commands in discovery order; dedupe exact repeats.
      const seen = new Set<string>();
      picked = [];
      for (const s of all) {
        if (!seen.has(s.command)) {
          seen.add(s.command);
          picked.push(s);
        }
      }
    }

    const results: string[] = [];
    let failed = false;
    for (const s of picked.slice(0, 5)) {
      const { ok, output } = await runCheck(s.command, cwd, timeout);
      failed ||= !ok;
      const head = output.split('\n').slice(0, 40).join('\n');
      results.push(`${ok ? 'PASS' : 'FAIL'}  ${s.command}  (${s.source})\n${head}`);
    }
    return `checks: ${failed ? 'FAILED' : 'all passed'}\n\n${results.join('\n\n')}`;
  },
}));

/** The 21, registered by name for the tools map and the `extra` tool set. */
export const extraTools = {
  insert_lines: insertLinesTool,
  delete_lines: deleteLinesTool,
  replace_lines: replaceLinesTool,
  append_file: appendFileTool,
  prepend_file: prependFileTool,
  count_lines: countLinesTool,
  tree: treeTool,
  file_info: fileInfoTool,
  find_files: findFilesTool,
  recent_files: recentFilesTool,
  changed_files: changedFilesTool,
  git_log_file: gitLogFileTool,
  git_diff_commits: gitDiffCommitsTool,
  git_show_file: gitShowFileTool,
  git_current_branch: gitCurrentBranchTool,
  git_changed_in_ref: gitChangedInRefTool,
  outline: outlineTool,
  read_symbol: readSymbolTool,
  env_info: envInfoTool,
  count_tokens: countTokensTool,
  run_checks: runChecksTool,
};

export const EXTRA_TOOL_NAMES = Object.keys(extraTools);
