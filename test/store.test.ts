import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import * as store from '../src/store';

let home: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env['SHIRO_HOME'];
  home = mkdtempSync(join(tmpdir(), 'shiro-home-'));
  process.env['SHIRO_HOME'] = home;
});

afterEach(() => {
  if (origHome === undefined) delete process.env['SHIRO_HOME'];
  else process.env['SHIRO_HOME'] = origHome;
  rmSync(home, { recursive: true, force: true });
});

const messages: ModelMessage[] = [
  { role: 'user', content: 'add pagination to /users' },
  { role: 'assistant', content: 'Done.' },
];

const rec = (id: string, cwd = '/repo'): store.SessionRecord => ({
  id,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  cwd,
  provider: 'openai',
  model: 'gpt-5',
  title: store.titleOf(messages),
  inputTokens: 100,
  outputTokens: 20,
  messages,
});

test('list on a fresh install returns nothing instead of throwing', async () => {
  expect(await store.list()).toEqual([]);
  expect(await store.latest()).toBeUndefined();
  expect(await store.resolveId('anything')).toBeUndefined();
});

test('save then load round-trips messages and metadata', async () => {
  await store.save(rec('aaa'));
  const back = await store.load('aaa');
  expect(back?.messages).toEqual(messages);
  expect(back?.model).toBe('gpt-5');
  expect(back?.inputTokens).toBe(100);
});

test('load of an unknown id returns undefined instead of throwing', async () => {
  expect(await store.load('nope')).toBeUndefined();
});

test('save stamps updatedAt so list can order by recency', async () => {
  await store.save(rec('aaa'));
  const back = await store.load('aaa');
  expect(back?.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
});

test('list returns newest first', async () => {
  await store.save(rec('older'));
  await Bun.sleep(5);
  await store.save(rec('newer'));
  const all = await store.list();
  expect(all.map((r) => r.id)).toEqual(['newer', 'older']);
});

test('latest filters by working directory', async () => {
  await store.save(rec('other', '/elsewhere'));
  await Bun.sleep(5);
  await store.save(rec('mine', '/repo'));
  expect((await store.latest('/repo'))?.id).toBe('mine');
  expect((await store.latest('/elsewhere'))?.id).toBe('other');
  expect((await store.latest('/nothing-here'))).toBeUndefined();
});

test('resolveId accepts a full id or a unique prefix, rejects an ambiguous one', async () => {
  await store.save(rec('0193aaaa-1'));
  await store.save(rec('0193bbbb-2'));
  expect(await store.resolveId('0193aaaa-1')).toBe('0193aaaa-1');
  expect(await store.resolveId('0193a')).toBe('0193aaaa-1');
  expect(await store.resolveId('0193')).toBeUndefined();
  expect(await store.resolveId('zzz')).toBeUndefined();
});

test('a corrupt session file is skipped, not fatal', async () => {
  await Bun.write(join(home, '.shiro-neko', 'sessions', 'broken.json'), '{ not json');
  await store.save(rec('good'));
  expect(await store.load('broken')).toBeUndefined();
  expect((await store.list()).map((r) => r.id)).toEqual(['good']);
});

test('the notebook survives a save and load', async () => {
  await store.save({
    ...rec('with-notebook'),
    notebook: { todos: [{ content: 'finish the parser', status: 'in_progress' }] },
  });
  const back = await store.load('with-notebook');
  expect(back?.notebook?.todos).toEqual([{ content: 'finish the parser', status: 'in_progress' }]);

});

test('titleOf uses the first user message and truncates', () => {
  expect(store.titleOf(messages)).toBe('add pagination to /users');
  expect(store.titleOf([])).toBe('untitled');
  const long = store.titleOf([{ role: 'user', content: 'x'.repeat(100) }]);
  expect(long.endsWith('...')).toBe(true);
  expect(long.length).toBe(63);
});
