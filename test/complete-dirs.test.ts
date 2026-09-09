import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walk } from '../src/ignore';
import { matchPaths, completePath, pathToken } from '../src/complete';

test('walk includeDirs yields directories with trailing slash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shiro-dirs-'));
  const orig = process.cwd();
  try {
    process.chdir(dir);
    await Bun.write('a.ts', '');
    mkdirSync('src/ui', { recursive: true });
    await Bun.write('src/ui/App.tsx', '');
    await Bun.write('src/session.ts', '');

    const out: string[] = [];
    for await (const p of walk({ includeDirs: true })) out.push(p);
    expect(out).toContain('src/');
    expect(out).toContain('src/ui/');
    expect(out).toContain('src/session.ts');
    expect(out).toContain('a.ts');
  } finally {
    process.chdir(orig);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('walk without includeDirs still file-only (existing behaviour)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shiro-nodirs-'));
  const orig = process.cwd();
  try {
    process.chdir(dir);
    mkdirSync('src', { recursive: true });
    await Bun.write('src/a.ts', '');
    const out: string[] = [];
    for await (const p of walk()) out.push(p);
    expect(out).not.toContain('src/');
    expect(out).toContain('src/a.ts');
  } finally {
    process.chdir(orig);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('matchPaths surfaces dirs for a directory prefix and keeps trailing slash through completion', () => {
  const paths = ['src/', 'src/ui/', 'src/ui/App.tsx', 'src/session.ts', 'README.md'];
  const hits = matchPaths(paths, 'src/');
  expect(hits).toContain('src/');
  expect(hits).toContain('src/ui/');
  // dirs rank before files for the same prefix
  expect(hits.indexOf('src/ui/')).toBeLessThan(hits.indexOf('src/ui/App.tsx'));

  // inserted dir keeps trailing slash and trailing space
  const tok = pathToken('@src/u', 6)!;
  const { value } = completePath('@src/u', tok, 'src/ui/');
  expect(value).toBe('src/ui/ ');
});

test('matchPaths with empty query prefers dirs', () => {
  const hits = matchPaths(['src/', 'a.ts', 'src/ui/', 'b.ts'], '', 3);
  expect(hits[0]).toBe('src/');
});
