import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walk } from '../src/ignore';

let dir: string;
let orig: string;

beforeEach(() => {
  orig = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'shiro-ignore-'));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(orig);
  rmSync(dir, { recursive: true, force: true });
});

const collect = async (opts: Parameters<typeof walk>[0] = {}) => {
  const out: string[] = [];
  for await (const p of walk(opts)) out.push(p);
  return out.sort();
};

test('walks nested files and returns posix relative paths', async () => {
  await Bun.write('a.ts', '');
  await Bun.write('src/deep/b.ts', '');
  expect(await collect()).toEqual(['a.ts', 'src/deep/b.ts']);
});

test('.git and node_modules are always skipped, even with no ignore file', async () => {
  await Bun.write('keep.ts', '');
  await Bun.write('node_modules/pkg/index.js', '');
  mkdirSync(join(dir, '.git'), { recursive: true });
  await Bun.write('.git/HEAD', 'ref: refs/heads/main');
  expect(await collect()).toEqual(['keep.ts']);
});

test('a plain gitignore entry excludes a file', async () => {
  await Bun.write('.gitignore', 'secret.txt\n');
  await Bun.write('secret.txt', '');
  await Bun.write('public.txt', '');
  expect(await collect()).toEqual(['.gitignore', 'public.txt']);
});

test('a directory rule excludes everything beneath it', async () => {
  await Bun.write('.gitignore', 'dist/\n');
  await Bun.write('dist/app.js', '');
  await Bun.write('dist/nested/app.js', '');
  await Bun.write('src/app.ts', '');
  expect(await collect()).toEqual(['.gitignore', 'src/app.ts']);
});

test('an unanchored name matches at any depth', async () => {
  await Bun.write('.gitignore', '*.log\n');
  await Bun.write('top.log', '');
  await Bun.write('deep/nested/inner.log', '');
  await Bun.write('deep/keep.ts', '');
  expect(await collect()).toEqual(['.gitignore', 'deep/keep.ts']);
});

test('a leading slash anchors the rule to the root', async () => {
  await Bun.write('.gitignore', '/build\n');
  await Bun.write('build/out.js', '');
  await Bun.write('src/build/out.js', '');
  expect(await collect()).toEqual(['.gitignore', 'src/build/out.js']);
});

test('a negation re-includes a file the previous rule excluded', async () => {
  await Bun.write('.gitignore', '*.env\n!keep.env\n');
  await Bun.write('secret.env', '');
  await Bun.write('keep.env', '');
  expect(await collect()).toEqual(['.gitignore', 'keep.env']);
});

test('** spans directories', async () => {
  await Bun.write('.gitignore', 'a/**/c.ts\n');
  await Bun.write('a/b/c.ts', '');
  await Bun.write('a/b/d/c.ts', '');
  await Bun.write('a/keep.ts', '');
  expect(await collect()).toEqual(['.gitignore', 'a/keep.ts']);
});

test('a nested gitignore applies only inside its own directory', async () => {
  await Bun.write('pkg/.gitignore', 'out.js\n');
  await Bun.write('pkg/out.js', '');
  await Bun.write('other/out.js', '');
  expect(await collect()).toEqual(['other/out.js', 'pkg/.gitignore']);
});

test('.shiroignore is honoured alongside .gitignore', async () => {
  await Bun.write('.shiroignore', 'notes/\n');
  await Bun.write('notes/todo.md', '');
  await Bun.write('src/app.ts', '');
  expect(await collect()).toEqual(['.shiroignore', 'src/app.ts']);
});

test('comments and blank lines are skipped', async () => {
  await Bun.write('.gitignore', '# a comment\n\n   \nreal.txt\n');
  await Bun.write('real.txt', '');
  await Bun.write('# a comment', '');
  expect(await collect()).toContain('# a comment');
  expect(await collect()).not.toContain('real.txt');
});

test('noIgnore returns everything except .git and node_modules', async () => {
  await Bun.write('.gitignore', 'dist/\n');
  await Bun.write('dist/app.js', '');
  await Bun.write('src/app.ts', '');
  expect(await collect({ noIgnore: true })).toEqual(['.gitignore', 'dist/app.js', 'src/app.ts']);
});

test('limit stops the walk early', async () => {
  for (let i = 0; i < 10; i++) await Bun.write(`f${i}.ts`, '');
  expect((await collect({ limit: 3 })).length).toBe(3);
});
