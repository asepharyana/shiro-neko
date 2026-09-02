import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendHistory, loadHistory } from '../src/store';

let home: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env['SHIRO_HOME'];
  home = mkdtempSync(join(tmpdir(), 'shiro-hist-'));
  process.env['SHIRO_HOME'] = home;
});

afterEach(() => {
  if (saved === undefined) delete process.env['SHIRO_HOME'];
  else process.env['SHIRO_HOME'] = saved;
  rmSync(home, { recursive: true, force: true });
});

test('a fresh project has no history', async () => {
  expect(await loadHistory('/repo/a')).toEqual([]);
});

test('prompts round-trip in submission order', async () => {
  await appendHistory('first', '/repo/a');
  await appendHistory('second', '/repo/a');
  expect(await loadHistory('/repo/a')).toEqual(['first', 'second']);
});

test('history is scoped per directory', async () => {
  await appendHistory('in a', '/repo/a');
  await appendHistory('in b', '/repo/b');
  expect(await loadHistory('/repo/a')).toEqual(['in a']);
  expect(await loadHistory('/repo/b')).toEqual(['in b']);
});

test('an immediate repeat is not stored twice', async () => {
  await appendHistory('same', '/repo/a');
  await appendHistory('same', '/repo/a');
  expect(await loadHistory('/repo/a')).toEqual(['same']);
});

test('a repeat that is not adjacent is kept', async () => {
  await appendHistory('a', '/repo/a');
  await appendHistory('b', '/repo/a');
  await appendHistory('a', '/repo/a');
  expect(await loadHistory('/repo/a')).toEqual(['a', 'b', 'a']);
});

test('blank prompts are ignored', async () => {
  await appendHistory('   ', '/repo/a');
  await appendHistory('', '/repo/a');
  expect(await loadHistory('/repo/a')).toEqual([]);
});

test('prompts are trimmed before storing', async () => {
  await appendHistory('  spaced  ', '/repo/a');
  expect(await loadHistory('/repo/a')).toEqual(['spaced']);
});

test('history is capped at 200 entries, keeping the newest', async () => {
  for (let i = 0; i < 210; i++) await appendHistory(`p${i}`, '/repo/a');
  const history = await loadHistory('/repo/a');
  expect(history).toHaveLength(200);
  expect(history[0]).toBe('p10');
  expect(history.at(-1)).toBe('p209');
});

test('a corrupt history file degrades to empty instead of throwing', async () => {
  await appendHistory('good', '/repo/a');
  const files: string[] = [];
  for await (const f of new Bun.Glob('*.json').scan({ cwd: join(home, '.shiro-neko', 'history'), onlyFiles: true })) {
    files.push(f);
  }
  await Bun.write(join(home, '.shiro-neko', 'history', files[0]!), '{ not json');
  expect(await loadHistory('/repo/a')).toEqual([]);
});

test('non-string entries are filtered out', async () => {
  await appendHistory('good', '/repo/a');
  const files: string[] = [];
  for await (const f of new Bun.Glob('*.json').scan({ cwd: join(home, '.shiro-neko', 'history'), onlyFiles: true })) {
    files.push(f);
  }
  await Bun.write(join(home, '.shiro-neko', 'history', files[0]!), JSON.stringify(['ok', 42, null, 'also ok']));
  expect(await loadHistory('/repo/a')).toEqual(['ok', 'also ok']);
});
