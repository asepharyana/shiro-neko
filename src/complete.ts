/**
 * `@path` completion, kept pure so the ranking and the insertion can be tested
 * without a terminal.
 */

export type PathToken = {
  /** Index of the `@`. */
  start: number;
  /** Index just past the token, always the cursor. */
  end: number;
  /** Text between the `@` and the cursor, possibly empty. */
  query: string;
};

/**
 * The `@`-token the cursor sits in, if any.
 *
 * The `@` has to start a word, or `user@host` and an email address would open a
 * file picker. A space ends the token, so `@src/a.ts and then` is not still
 * completing after the space.
 */
export function pathToken(value: string, cursor: number): PathToken | undefined {
  const before = value.slice(0, cursor);
  const at = before.lastIndexOf('@');
  if (at === -1) return undefined;

  const prev = at === 0 ? undefined : before[at - 1];
  if (prev !== undefined && !/\s/.test(prev)) return undefined;

  const query = before.slice(at + 1);
  if (/\s/.test(query)) return undefined;

  return { start: at, end: cursor, query };
}

const MAX_MATCHES = 8;

/**
 * Paths worth offering for a query.
 *
 * Prefix matches come first because `@src/` means "under src/", and a substring
 * match on some other directory would bury the thing the user is pointing at.
 * Ties break on path length: the shallower file is more often the one meant.
 */
export function matchPaths(paths: readonly string[], query: string, limit = MAX_MATCHES): string[] {
  if (!query) {
    const dirs = paths.filter((p) => p.endsWith('/'));
    const files = paths.filter((p) => !p.endsWith('/'));
    const byLength = (a: string, b: string) => a.length - b.length || a.localeCompare(b);
    // Empty query: prefer directories (the user just typed `@src/` and wants to go deeper)
    // when available, otherwise fall back to the shallowest files.
    if (dirs.length > 0) return [...dirs.sort(byLength), ...files.sort(byLength)].slice(0, limit);
    return [...files.sort(byLength)].slice(0, limit);
  }

  const needle = query.toLowerCase();
  const prefixDirs: string[] = [];
  const prefixFiles: string[] = [];
  const substringDirs: string[] = [];
  const substringFiles: string[] = [];

  for (const path of paths) {
    const lower = path.toLowerCase();
    const isDir = path.endsWith('/');
    const hit = lower.startsWith(needle) ? 'prefix' : lower.includes(needle) ? 'substring' : undefined;
    if (!hit) continue;
    if (hit === 'prefix') (isDir ? prefixDirs : prefixFiles).push(path);
    else (isDir ? substringDirs : substringFiles).push(path);
  }

  const byLength = (a: string, b: string) => a.length - b.length || a.localeCompare(b);
  return [
    ...prefixDirs.sort(byLength),
    ...prefixFiles.sort(byLength),
    ...substringDirs.sort(byLength),
    ...substringFiles.sort(byLength),
  ].slice(0, limit);
}

export type Completion = { value: string; cursor: number };

/** Replaces the token with a plain relative path and a trailing space (dirs keep their trailing `/`). */
export function completePath(value: string, token: PathToken, path: string): Completion {
  const next = `${value.slice(0, token.start)}${path} ${value.slice(token.end)}`;
  return { value: next, cursor: token.start + path.length + 1 };
}
