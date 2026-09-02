import { afterEach, beforeEach, expect, test } from 'bun:test';
import { MockLanguageModelV4 } from 'ai/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolSet } from 'ai';
import { Memory } from '../src/memory';
import { systemPrompt } from '../src/prompt';

let home: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env['SHIRO_HOME'];
  home = mkdtempSync(join(tmpdir(), 'shiro-mem-'));
  process.env['SHIRO_HOME'] = home;
});

afterEach(() => {
  if (saved === undefined) delete process.env['SHIRO_HOME'];
  else process.env['SHIRO_HOME'] = saved;
  rmSync(home, { recursive: true, force: true });
});

const call = (tools: ToolSet, name: string, input: Record<string, unknown>) => {
  const t = tools[name];
  if (!t?.execute) throw new Error(`${name} is not executable`);
  return Promise.resolve(t.execute(input as never, { toolCallId: 'x', messages: [] } as never)) as Promise<string>;
};

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1 },
} as any;

const summarizer = (text: string) =>
  new MockLanguageModelV4({
    doGenerate: async () =>
      ({
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      }) as any,
  });

test('a fresh project has no memory and renders nothing', async () => {
  const m = new Memory('/repo');
  expect(await m.load()).toEqual([]);
  expect(m.render()).toBe('');
});

test('an entry round-trips through a second Memory instance', async () => {
  const first = new Memory('/repo');
  await first.add('command', 'tests run with bun test');

  const second = new Memory('/repo');
  const entries = await second.load();
  expect(entries).toHaveLength(1);
  expect(entries[0]?.text).toBe('tests run with bun test');
  expect(entries[0]?.kind).toBe('command');
});

test('memory is scoped per directory', async () => {
  await new Memory('/repo/a').add('fact', 'only in a');
  await new Memory('/repo/b').add('fact', 'only in b');

  expect((await new Memory('/repo/a').load()).map((e) => e.text)).toEqual(['only in a']);
  expect((await new Memory('/repo/b').load()).map((e) => e.text)).toEqual(['only in b']);
});

test('the same text is not stored twice', async () => {
  const m = new Memory('/repo');
  expect(await m.add('fact', 'duplicate')).toBeDefined();
  expect(await m.add('fact', 'duplicate')).toBeUndefined();
  expect(m.all()).toHaveLength(1);
});

test('an empty note is refused', async () => {
  const m = new Memory('/repo');
  expect(m.add('fact', '   ')).rejects.toThrow(/empty/);
});

test('long text is truncated', async () => {
  const m = new Memory('/repo');
  const entry = await m.add('fact', 'x'.repeat(2000));
  expect(entry?.text.length).toBe(400);
});

test('search requires every term and records a hit', async () => {
  const m = new Memory('/repo');
  await m.add('decision', 'we chose snake_case for database columns');
  await m.add('fact', 'the api is versioned under /v2');

  expect((await m.search('snake_case columns')).map((e) => e.text)).toEqual([
    'we chose snake_case for database columns',
  ]);
  expect(await m.search('snake_case missing')).toEqual([]);
  expect(m.all().find((e) => e.text.includes('snake_case'))?.hits).toBe(1);
});

test('a hit survives a reload, so usage is durable', async () => {
  const m = new Memory('/repo');
  await m.add('fact', 'searchable thing');
  await m.search('searchable');

  expect((await new Memory('/repo').load())[0]?.hits).toBe(1);
});

test('search refuses an empty query', async () => {
  const m = new Memory('/repo');
  expect(m.search('  ')).rejects.toThrow(/empty/);
});

test('the boot block ranks recalled entries above unused ones', async () => {
  const m = new Memory('/repo');
  await m.add('fact', 'never looked up');
  await m.add('fact', 'frequently needed');
  await m.search('frequently');
  await m.search('frequently');

  const lines = m.render().split('\n').filter((l) => l.startsWith('- '));
  expect(lines[0]).toContain('frequently needed');
});

test('the boot block reaches the system prompt', async () => {
  const m = new Memory('/repo');
  await m.add('gotcha', 'the migration must run before the seed');

  const prompt = systemPrompt({ cwd: '/repo', memory: m.render() });
  expect(prompt).toContain('earlier sessions');
  expect(prompt).toContain('the migration must run before the seed');
});

test('forget removes by substring', async () => {
  const m = new Memory('/repo');
  const tools = m.tools();
  await call(tools, 'remember', { kind: 'fact', text: 'wrong thing about the parser' });
  await call(tools, 'remember', { kind: 'fact', text: 'correct thing' });

  expect(await call(tools, 'forget', { text: 'wrong thing' })).toContain('Forgot 1');
  expect(m.all().map((e) => e.text)).toEqual(['correct thing']);
});

test('forget reports when nothing matches', async () => {
  const m = new Memory('/repo');
  expect(await call(m.tools(), 'forget', { text: 'nothing' })).toContain('No memory matches');
});

test('the remember tool reports the kind and running count', async () => {
  const m = new Memory('/repo');
  const out = await call(m.tools(), 'remember', { kind: 'decision', text: 'chose Bun over Node' });
  expect(out).toContain('decision');
  expect(out).toContain('1 stored');
});

test('the recall tool says so plainly when nothing matches', async () => {
  const m = new Memory('/repo');
  expect(await call(m.tools(), 'recall', { query: 'absent' })).toContain('Nothing recorded');
});

test('a corrupt memory file degrades to empty rather than throwing', async () => {
  const m = new Memory('/repo');
  await m.add('fact', 'seed');

  const files: string[] = [];
  for await (const f of new Bun.Glob('*.json').scan({ cwd: join(home, '.shiro-neko', 'memory'), onlyFiles: true })) {
    files.push(f);
  }
  await Bun.write(join(home, '.shiro-neko', 'memory', files[0]!), '{ not json');

  expect(await new Memory('/repo').load()).toEqual([]);
});

test('non-entry values in the file are filtered out', async () => {
  const m = new Memory('/repo');
  await m.add('fact', 'seed');
  const files: string[] = [];
  for await (const f of new Bun.Glob('*.json').scan({ cwd: join(home, '.shiro-neko', 'memory'), onlyFiles: true })) {
    files.push(f);
  }
  await Bun.write(
    join(home, '.shiro-neko', 'memory', files[0]!),
    JSON.stringify([{ id: 'a', kind: 'fact', text: 'ok', createdAt: 'now', hits: 0 }, { junk: true }, 42]),
  );
  expect((await new Memory('/repo').load()).map((e) => e.text)).toEqual(['ok']);
});

test('summarize merges unused entries and keeps recalled ones verbatim', async () => {
  const m = new Memory('/repo', summarizer('[fact] merged note one\n[command] merged note two'));
  await m.add('fact', 'unused one');
  await m.add('fact', 'unused two');
  await m.add('fact', 'important, was recalled');
  await m.search('important');

  const { before, after } = await m.summarize();
  expect(before).toBe(3);
  expect(after).toBe(3);

  const texts = m.all().map((e) => e.text);
  expect(texts).toContain('important, was recalled');
  expect(texts).toContain('merged note one');
  expect(texts).toContain('merged note two');
  expect(texts).not.toContain('unused one');
});

test('summarize survives a reload', async () => {
  const m = new Memory('/repo', summarizer('[fact] one merged line'));
  await m.add('fact', 'a');
  await m.add('fact', 'b');
  await m.summarize();

  expect((await new Memory('/repo').load()).map((e) => e.text)).toEqual(['one merged line']);
});

test('a model that returns nothing parseable leaves memory untouched', async () => {
  const m = new Memory('/repo', summarizer('I could not do that, sorry.'));
  await m.add('fact', 'keep me');
  await m.add('fact', 'keep me too');

  const { before, after } = await m.summarize();
  expect(after).toBe(before);
  expect(m.all()).toHaveLength(2);
});

test('summarize with fewer than two unused entries is a no-op', async () => {
  const m = new Memory('/repo', summarizer('[fact] should not be used'));
  await m.add('fact', 'lonely');
  const { before, after } = await m.summarize();
  expect(after).toBe(before);
  expect(m.all().map((e) => e.text)).toEqual(['lonely']);
});

test('summarize without a model is an explicit error', async () => {
  const m = new Memory('/repo');
  await m.add('fact', 'anything');
  expect(m.summarize()).rejects.toThrow(/no model/);
});

test('needsSummary trips once the store grows', async () => {
  const m = new Memory('/repo');
  expect(m.needsSummary()).toBe(false);
  for (let i = 0; i < 60; i++) await m.add('fact', `note ${i}`);
  expect(m.needsSummary()).toBe(true);
});

test('clear empties the store on disk', async () => {
  const m = new Memory('/repo');
  await m.add('fact', 'temporary');
  await m.clear();
  expect(await new Memory('/repo').load()).toEqual([]);
});
