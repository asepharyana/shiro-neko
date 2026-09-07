import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSymbolTool, jsonQueryTool, tools, toolSetOf } from '../src/tools';

let dir: string;
let origCwd: string;

beforeEach(() => {
  origCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'shiro-nav-'));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(dir, { recursive: true, force: true });
});

const run = <T>(t: { execute?: (input: T, opts: any) => unknown }, input: T) =>
  Promise.resolve(t.execute!(input, { toolCallId: 't1', messages: [] })) as Promise<string>;

test('the new tools are registered and assigned to the nav set', () => {
  expect(tools['find_symbol']).toBeDefined();
  expect(tools['json_query']).toBeDefined();
  expect(toolSetOf('find_symbol')).toBe('nav');
  expect(toolSetOf('json_query')).toBe('nav');
});

test('find_symbol jumps to a function declaration, not its uses', async () => {
  await Bun.write(
    'src/util.ts',
    'export function parseConfig() {\n  return {};\n}\n\nconst x = parseConfig();\nparseConfig();\n',
  );
  const out = await run(findSymbolTool, { name: 'parseConfig' });
  // Exactly one hit, at the declaration on line 1, not the two calls below it.
  expect(out).toContain('src/util.ts:1');
  expect(out).toContain('function parseConfig');
  expect(out.split('\n')).toHaveLength(1);
});

test('find_symbol finds a Python def and a class', async () => {
  await Bun.write('app.py', 'class Server:\n    pass\n\ndef serve():\n    pass\n');
  const cls = await run(findSymbolTool, { name: 'Server' });
  expect(cls).toContain('app.py:1');
  const fn = await run(findSymbolTool, { name: 'serve' });
  expect(fn).toContain('app.py:4');
});

test('find_symbol reports a miss plainly and escapes regex metacharacters', async () => {
  await Bun.write('a.ts', 'const other = 1;\n');
  expect(await run(findSymbolTool, { name: 'missing' })).toBe('No definition of "missing" found.');
  // A name with regex metacharacters must not throw or match wildly.
  expect(await run(findSymbolTool, { name: 'a.b(c)' })).toContain('No definition');
});

test('find_symbol skips comments', async () => {
  await Bun.write('c.ts', '// function fake() {}\nfunction real() {}\n');
  const out = await run(findSymbolTool, { name: 'fake' });
  expect(out).toContain('No definition');
});

test('json_query reads a nested value by dotted path', async () => {
  await Bun.write('package.json', JSON.stringify({ scripts: { build: 'tsc', test: 'vitest' }, name: 'demo' }));
  expect(await run(jsonQueryTool, { path: 'package.json', query: 'scripts.build' })).toBe('scripts.build = tsc');
});

test('json_query walks arrays with numeric segments', async () => {
  await Bun.write('data.json', JSON.stringify({ items: [{ id: 'a' }, { id: 'b' }] }));
  expect(await run(jsonQueryTool, { path: 'data.json', query: 'items.1.id' })).toBe('items.1.id = b');
});

test('json_query renders an object value as JSON', async () => {
  await Bun.write('c.json', JSON.stringify({ deps: { react: '^19' } }));
  const out = await run(jsonQueryTool, { path: 'c.json', query: 'deps' });
  expect(out).toContain('react');
  expect(out).toContain('^19');
});

test('json_query names the keys present when a segment misses', async () => {
  await Bun.write('c.json', JSON.stringify({ scripts: { build: 'x' } }));
  const out = run(jsonQueryTool, { path: 'c.json', query: 'scripts.deploy' });
  await expect(out).rejects.toThrow(/no key "deploy"/);
  await expect(out).rejects.toThrow(/build/);
});

test('json_query refuses a missing file and invalid JSON', async () => {
  await expect(run(jsonQueryTool, { path: 'nope.json', query: 'a' })).rejects.toThrow(/No such file/);
  await Bun.write('bad.json', '{ not json');
  await expect(run(jsonQueryTool, { path: 'bad.json', query: 'a' })).rejects.toThrow(/not valid JSON/);
});

test('json_query stays inside the workspace', async () => {
  await expect(run(jsonQueryTool, { path: '../../etc/passwd', query: 'a' })).rejects.toThrow();
});
