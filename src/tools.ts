import { tool } from 'ai';
import { resolve } from 'node:path';
import { z } from 'zod';
import { jail, posix, walk } from './ignore';

/** Max chars returned by any single tool. Beyond this the output is truncated. */
const MAX_OUTPUT = 30_000;
const MAX_GREP_HITS = 200;
/** Bytes sniffed for a NUL to decide a file is not text. */
const SNIFF_BYTES = 8192;

function cap(s: string): string {
  return s.length <= MAX_OUTPUT ? s : `${s.slice(0, MAX_OUTPUT)}\n... [truncated ${s.length - MAX_OUTPUT} chars]`;
}

/**
 * A NUL byte in the first few KB means this is not text. Cheap, and the same
 * heuristic git and ripgrep use; without it a model can burn its whole context
 * on one accidental `read_file dist/binary`.
 */
async function isBinary(abs: string): Promise<boolean> {
  const bytes = new Uint8Array(await Bun.file(abs).slice(0, SNIFF_BYTES).arrayBuffer());
  return bytes.includes(0);
}

export const readFileTool = tool({
  description: 'Read a UTF-8 text file. Returns contents with 1-based line numbers.',
  inputSchema: z.object({
    path: z.string().describe('File path relative to the workspace root'),
    offset: z.number().int().min(1).optional().describe('First line to return (1-based)'),
    limit: z.number().int().min(1).optional().describe('Max lines to return, default 2000'),
  }),
  execute: async ({ path, offset = 1, limit = 2000 }) => {
    const abs = jail(path);
    const file = Bun.file(abs);
    if (!(await file.exists())) throw new Error(`No such file: ${path}`);
    if (await isBinary(abs)) throw new Error(`${path} is a binary file, not text. Use bash if you need to inspect it.`);
    const lines = (await file.text()).split('\n');
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    return cap(slice.map((l, i) => `${offset + i}: ${l}`).join('\n'));
  },
});

export const writeFileTool = tool({
  description: 'Create a file or overwrite it completely. Prefer edit_file for existing files.',
  inputSchema: z.object({
    path: z.string(),
    content: z.string(),
  }),
  execute: async ({ path, content }) => {
    const abs = jail(path);
    await Bun.write(abs, content);
    return `Wrote ${content.length} chars to ${path}`;
  },
});

export const editFileTool = tool({
  description:
    'Replace an exact string in a file. oldString must appear exactly once unless replaceAll is true. Include surrounding context to make oldString unique.',
  inputSchema: z.object({
    path: z.string(),
    oldString: z.string().describe('Exact text to find, including whitespace and indentation'),
    newString: z.string().describe('Replacement text'),
    replaceAll: z.boolean().optional().describe('Replace every occurrence instead of requiring exactly one'),
  }),
  execute: async ({ path, oldString, newString, replaceAll = false }) => {
    if (oldString === newString) throw new Error('oldString and newString are identical');
    const abs = jail(path);
    const file = Bun.file(abs);
    if (!(await file.exists())) throw new Error(`No such file: ${path}`);
    const before = await file.text();

    const count = before.split(oldString).length - 1;
    if (count === 0) throw new Error(`oldString not found in ${path}`);
    if (count > 1 && !replaceAll) {
      throw new Error(`oldString appears ${count} times in ${path}. Add surrounding context or set replaceAll.`);
    }

    const after = replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString);
    await Bun.write(abs, after);
    return `Replaced ${replaceAll ? count : 1} occurrence(s) in ${path}`;
  },
});

export const globTool = tool({
  description:
    'Find files by glob pattern, e.g. "src/**/*.ts". Skips anything .gitignore excludes. Returns paths relative to the workspace root.',
  inputSchema: z.object({
    pattern: z.string(),
    limit: z.number().int().min(1).optional().describe('Max paths to return, default 200'),
    includeIgnored: z.boolean().optional().describe('Also search files git ignores'),
  }),
  execute: async ({ pattern, limit = 200, includeIgnored = false }) => {
    const glob = new Bun.Glob(pattern);
    const hits: string[] = [];
    for await (const rel of walk({ noIgnore: includeIgnored })) {
      if (!glob.match(rel)) continue;
      hits.push(rel);
      if (hits.length >= limit) break;
    }
    return hits.length ? hits.join('\n') : 'No files matched.';
  },
});

type GrepArgs = { pattern: string; include?: string; ignoreCase?: boolean; includeIgnored?: boolean };

/**
 * ripgrep is 10-100x faster than walking in JS and already understands
 * .gitignore and binary detection, so use it whenever it is installed.
 * Output shape stays identical to the fallback so the model sees one format.
 */
async function grepWithRipgrep({ pattern, include, ignoreCase, includeIgnored }: GrepArgs): Promise<string | undefined> {
  // --no-require-git: rg skips .gitignore outside a repo by default, but the JS
  // fallback always honours it, and the two paths must agree.
  const args = [
    '--line-number',
    '--no-heading',
    '--color',
    'never',
    '--no-require-git',
    '--max-count',
    String(MAX_GREP_HITS),
  ];
  if (ignoreCase) args.push('--ignore-case');
  if (includeIgnored) args.push('--no-ignore');
  if (include) args.push('--glob', include);
  args.push('--regexp', pattern, '.');

  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn(['rg', ...args], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
  } catch {
    return undefined;
  }

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  // 0 = matches, 1 = no matches. Anything else means rg could not run the search.
  if (code > 1) {
    if (/regex parse error|error parsing/i.test(stderr)) throw new Error(`Invalid regex: ${stderr.trim()}`);
    return undefined;
  }
  if (code === 1) return 'No matches.';

  const hits = stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter(Boolean)
    .map((line) => {
      const m = /^(.*?):(\d+):(.*)$/.exec(line);
      if (!m) return line;
      // rg prefixes every path with the search root and uses native separators.
      const rel = posix(m[1]!).replace(/^\.\//, '');
      return `${rel}:${m[2]}: ${m[3]!.slice(0, 300)}`;
    })
    .slice(0, MAX_GREP_HITS);

  return cap(hits.join('\n'));
}

async function grepInJs({ pattern, include = '**/*', ignoreCase, includeIgnored }: GrepArgs): Promise<string> {
  let re: RegExp;
  try {
    re = new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch (e) {
    throw new Error(`Invalid regex: ${(e as Error).message}`);
  }

  const glob = new Bun.Glob(include);
  const hits: string[] = [];
  for await (const rel of walk({ noIgnore: includeIgnored })) {
    if (!glob.match(rel)) continue;
    const abs = resolve(process.cwd(), rel);
    let text: string;
    try {
      if (await isBinary(abs)) continue;
      text = await Bun.file(abs).text();
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (re.test(line)) hits.push(`${rel}:${i + 1}: ${line.slice(0, 300)}`);
      if (hits.length >= MAX_GREP_HITS) return cap(`${hits.join('\n')}\n... [hit limit ${MAX_GREP_HITS}]`);
    }
  }
  return hits.length ? cap(hits.join('\n')) : 'No matches.';
}

export const grepTool = tool({
  description:
    'Search file contents with a regular expression. Skips binaries and anything .gitignore excludes. Returns path:line:text hits.',
  inputSchema: z.object({
    pattern: z.string().describe('Regex source. ripgrep syntax when available, otherwise JavaScript'),
    include: z.string().optional().describe('Glob limiting which files are searched, default "**/*"'),
    ignoreCase: z.boolean().optional(),
    includeIgnored: z.boolean().optional().describe('Also search files git ignores'),
  }),
  execute: async (args) => (await grepWithRipgrep(args)) ?? (await grepInJs(args)),
});

export type BashOutput = { toolCallId: string; chunk: string };

/** Set by Session so long-running commands can report progress before exiting. */
let bashListener: ((out: BashOutput) => void) | undefined;

export function onBashOutput(fn: ((out: BashOutput) => void) | undefined): void {
  bashListener = fn;
}

async function pump(
  stream: ReadableStream<Uint8Array> | undefined,
  toolCallId: string,
): Promise<string> {
  if (!stream) return '';
  const decoder = new TextDecoder();
  let all = '';
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    if (!text) continue;
    all += text;
    bashListener?.({ toolCallId, chunk: text });
  }
  return all;
}

export const bashTool = tool({
  description: 'Run a shell command in the workspace root. Use for builds, tests, git, and package managers.',
  inputSchema: z.object({
    command: z.string(),
    timeout: z.number().int().min(1000).max(600_000).optional().describe('Timeout in ms, default 120000'),
  }),
  execute: async ({ command, timeout = 120_000 }, { toolCallId, abortSignal }) => {
    const shell = process.platform === 'win32' ? ['cmd', '/c', command] : ['bash', '-lc', command];
    const proc = Bun.spawn(shell, {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout,
      ...(abortSignal ? { signal: abortSignal } : {}),
    });

    // Drained concurrently: a command that fills one pipe while we block on the
    // other would deadlock, and buffering both hides progress for minutes.
    const [stdout, stderr, exitCode] = await Promise.all([
      pump(proc.stdout as ReadableStream<Uint8Array>, toolCallId),
      pump(proc.stderr as ReadableStream<Uint8Array>, toolCallId),
      proc.exited,
    ]);

    return cap(
      [
        `exit: ${exitCode}`,
        proc.signalCode && `(killed by ${proc.signalCode}; timeout is ${timeout}ms)`,
        stdout.trim() && `stdout:\n${stdout.trim()}`,
        stderr.trim() && `stderr:\n${stderr.trim()}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
  },
});

export const tools = {
  read_file: readFileTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  glob: globTool,
  grep: grepTool,
  bash: bashTool,
};

/** Tools that mutate the workspace or run arbitrary code always ask the user first. */
export const MUTATING_TOOLS = ['write_file', 'edit_file', 'bash'] as const;

export { jail };
