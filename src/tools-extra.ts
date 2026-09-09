import { tool } from 'ai';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
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

/** The 20, registered by name for the tools map and the `extra` tool set. */
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
};

export const EXTRA_TOOL_NAMES = Object.keys(extraTools);
