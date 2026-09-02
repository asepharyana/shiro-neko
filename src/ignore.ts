import { isAbsolute, join, relative, resolve } from 'node:path';
import { readdir as readdirFs, stat as statFs } from 'node:fs/promises';

const ALWAYS_SKIP = ['.git', 'node_modules'];

type Rule = {
  /** Directory the rule was declared in, relative and posix-separated. */
  base: string;
  negated: boolean;
  dirOnly: boolean;
  re: RegExp;
};

const posix = (p: string) => p.replaceAll('\\', '/');

/**
 * Translates one gitignore pattern into a regex over posix-relative paths.
 * Supports `!` negation, trailing `/`, leading `/` anchoring, `*`, `?`, and `**`.
 */
function compile(pattern: string, base: string): Rule | undefined {
  let body = pattern.trim();
  if (!body || body.startsWith('#')) return undefined;

  const negated = body.startsWith('!');
  if (negated) body = body.slice(1);

  const dirOnly = body.endsWith('/');
  if (dirOnly) body = body.slice(0, -1);

  const anchored = body.startsWith('/') || body.slice(0, -1).includes('/');
  if (body.startsWith('/')) body = body.slice(1);
  if (!body) return undefined;

  let re = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '*') {
      if (body[i + 1] === '*') {
        // `**/` spans any number of directories, bare `**` spans anything.
        if (body[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(ch)) re += `\\${ch}`;
    else re += ch;
  }

  // An unanchored pattern matches at any depth; both forms also match everything
  // beneath a matched directory.
  const prefix = anchored ? '' : '(?:.*/)?';
  return { base, negated, dirOnly, re: new RegExp(`^${prefix}${re}(?:/.*)?$`) };
}

async function rulesIn(root: string, dir: string): Promise<Rule[]> {
  const base = posix(relative(root, dir));
  const out: Rule[] = [];
  for (const name of ['.gitignore', '.shiroignore']) {
    const file = Bun.file(join(dir, name));
    if (!(await file.exists())) continue;
    for (const line of (await file.text()).split('\n')) {
      const rule = compile(line, base);
      if (rule) out.push(rule);
    }
  }
  return out;
}

function ignored(relPath: string, isDir: boolean, rules: Rule[]): boolean {
  let hit = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    const scoped = rule.base ? (relPath.startsWith(`${rule.base}/`) ? relPath.slice(rule.base.length + 1) : undefined) : relPath;
    if (scoped === undefined) continue;
    // Later rules win, which is how git resolves a negation after an ignore.
    if (rule.re.test(scoped)) hit = !rule.negated;
  }
  return hit;
}

export type WalkOptions = {
  root?: string;
  /** Include files git would ignore. */
  noIgnore?: boolean;
  limit?: number;
};

/**
 * Yields workspace-relative posix paths, skipping .git, node_modules, and anything
 * .gitignore or .shiroignore excludes. Nested ignore files are honoured, so a
 * `dist/` rule in a subpackage only applies inside it.
 */
export async function* walk(options: WalkOptions = {}): AsyncGenerator<string> {
  const root = resolve(options.root ?? process.cwd());
  const limit = options.limit ?? Infinity;
  let yielded = 0;

  const queue: { dir: string; rules: Rule[] }[] = [
    { dir: root, rules: options.noIgnore ? [] : await rulesIn(root, root) },
  ];

  while (queue.length > 0) {
    const { dir, rules } = queue.shift()!;
    let entries: Entry[];
    try {
      entries = await Promise.all(
        (await readdirFs(dir, { withFileTypes: true })).map(async (d) => ({
          name: d.name,
          // readdir reports a symlinked directory as a non-directory, which made
          // junctions leak past `dir/` ignore rules and be yielded as files with a
          // nonsense size. One stat per link fixes the classification.
          isDirectory: d.isDirectory() || (d.isSymbolicLink() && (await isDirLink(join(dir, d.name)))),
          isLink: d.isSymbolicLink(),
        })),
      );
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (ALWAYS_SKIP.includes(entry.name)) continue;
      const full = join(dir, entry.name);
      const rel = posix(relative(root, full));
      if (!options.noIgnore && ignored(rel, entry.isDirectory, rules)) continue;

      if (entry.isDirectory) {
        // A symlinked directory is not descended into: it can point anywhere,
        // including back into the tree.
        if (entry.isLink) continue;
        const nested = options.noIgnore ? rules : [...rules, ...(await rulesIn(root, full))];
        queue.push({ dir: full, rules: nested });
      } else {
        yield rel;
        if (++yielded >= limit) return;
      }
    }
  }
}

async function isDirLink(path: string): Promise<boolean> {
  try {
    return (await statFs(path)).isDirectory();
  } catch {
    return false;
  }
}

type Entry = { name: string; isDirectory: boolean; isLink: boolean };

/** Resolves a model-supplied path inside the workspace, rejecting escapes. */
export function jail(p: string, root = process.cwd()): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(resolve(root), abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return abs;
}

export { posix };
