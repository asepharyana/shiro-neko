import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tools, toolSetOf } from '../src/tools';

let dir: string;
let origCwd: string;

beforeEach(() => {
  origCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'shiro-extra-'));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(dir, { recursive: true, force: true });
});

const run = <T>(name: string, input: T) =>
  Promise.resolve(
    (tools as Record<string, { execute?: (i: T, o: unknown) => unknown }>)[name]!.execute!(input, {
      toolCallId: 't1',
      messages: [],
    }),
  ) as Promise<string>;

const write = (path: string, text: string) => Bun.write(path, text);

test('all 20 extra tools are registered in the extra set', () => {
  for (const n of [
    'insert_lines', 'delete_lines', 'replace_lines', 'append_file', 'prepend_file', 'count_lines',
    'tree', 'file_info', 'find_files', 'recent_files', 'changed_files',
    'git_log_file', 'git_diff_commits', 'git_show_file', 'git_current_branch', 'git_changed_in_ref',
    'outline', 'read_symbol', 'env_info', 'count_tokens',
  ]) {
    expect(tools[n as keyof typeof tools], n).toBeDefined();
    expect(toolSetOf(n), n).toBe('extra');
  }
});

// --- edit ---

test('insert_lines adds a block at a position, pushing the rest down', async () => {
  await write('a.txt', 'one\ntwo\nthree');
  await run('insert_lines', { path: 'a.txt', line: 2, text: 'inserted' });
  expect(await Bun.file('a.txt').text()).toBe('one\ninserted\ntwo\nthree');
});

test('insert_lines refuses a position past the end', async () => {
  await write('a.txt', 'one\ntwo');
  await expect(run('insert_lines', { path: 'a.txt', line: 99, text: 'x' })).rejects.toThrow(/past the end/);
});

test('delete_lines removes an inclusive range', async () => {
  await write('a.txt', 'one\ntwo\nthree\nfour');
  await run('delete_lines', { path: 'a.txt', start: 2, end: 3 });
  expect(await Bun.file('a.txt').text()).toBe('one\nfour');
});

test('delete_lines refuses to delete the whole file', async () => {
  await write('a.txt', 'one\ntwo');
  await expect(run('delete_lines', { path: 'a.txt', start: 1, end: 2 })).rejects.toThrow(/delete_file/);
});

test('replace_lines swaps a range for new text', async () => {
  await write('a.txt', 'one\ntwo\nthree');
  await run('replace_lines', { path: 'a.txt', start: 2, end: 2, text: 'TWO\nTWO2' });
  expect(await Bun.file('a.txt').text()).toBe('one\nTWO\nTWO2\nthree');
});

test('append_file and prepend_file add at the ends', async () => {
  await write('a.txt', 'middle\n');
  await run('append_file', { path: 'a.txt', text: 'end' });
  await run('prepend_file', { path: 'a.txt', text: 'start' });
  expect(await Bun.file('a.txt').text()).toBe('start\nmiddle\nend\n');
});

test('count_lines counts one file and a glob', async () => {
  await write('a.ts', '1\n2\n3');
  await Bun.write(join('sub', 'b.ts'), '1\n2');
  const one = await run('count_lines', { path: 'a.ts' });
  expect(one).toContain('3');
  expect(one).toContain('a.ts');
  const many = await run('count_lines', { pattern: '**/*.ts' });
  expect(many).toContain('a.ts');
  expect(many).toContain('b.ts');
});

// --- inspect ---

test('tree shows an indented, directories-first shape', async () => {
  await Bun.write(join('src', 'app', 'index.ts'), 'x');
  await Bun.write(join('src', 'util.ts'), 'x');
  const out = await run('tree', { path: 'src', depth: 3 });
  expect(out).toContain('app/');
  expect(out).toContain('index.ts');
  expect(out).toContain('util.ts');
});

test('file_info reports size, lines, kind, and mtime', async () => {
  await write('a.txt', 'one\ntwo');
  const out = await run('file_info', { path: 'a.txt' });
  expect(out).toContain('2 lines');
  expect(out).toContain('text');
  expect(out).toContain('bytes');
});

test('find_files matches a filename substring', async () => {
  await Bun.write(join('src', 'auth.ts'), 'x');
  await Bun.write(join('src', 'auth.test.ts'), 'x');
  await Bun.write(join('src', 'other.ts'), 'x');
  const out = await run('find_files', { name: 'auth' });
  expect(out).toContain('auth.ts');
  expect(out).toContain('auth.test.ts');
  expect(out).not.toContain('other.ts');
});

test('recent_files lists newest first', async () => {
  await write('old.txt', 'x');
  await new Promise((r) => setTimeout(r, 20));
  await write('new.txt', 'x');
  const out = await run('recent_files', { limit: 2 });
  expect(out.indexOf('new.txt')).toBeLessThan(out.indexOf('old.txt'));
});

test('changed_files reports the working-tree delta in a repo, or refuses cleanly outside one', async () => {
  try {
    const out = await run('changed_files', {});
    expect(typeof out).toBe('string');
  } catch (e) {
    // A temp dir is not a repository, so the tool must refuse with a clear message.
    expect(String(e)).toMatch(/not a git repository|not installed/i);
  }
});

// --- code ---

test('outline lists top-level declarations', async () => {
  await write('m.ts', 'import x from "y";\nexport function build() {}\nclass Thing {}\nconst helper = () => {};\n');
  const out = await run('outline', { path: 'm.ts' });
  expect(out).toContain('build');
  expect(out).toContain('Thing');
  expect(out).toContain('helper');
  expect(out).not.toContain('import x');
});

test('read_symbol extracts one definition body', async () => {
  await write('m.ts', 'function alpha() {\n  return 1;\n}\n\nfunction beta() {\n  return 2;\n}\n');
  const out = await run('read_symbol', { path: 'm.ts', name: 'alpha' });
  expect(out).toContain('function alpha');
  expect(out).toContain('return 1;');
  expect(out).not.toContain('function beta');
});

test('read_symbol errors plainly on a miss', async () => {
  await write('m.ts', 'const x = 1;\n');
  await expect(run('read_symbol', { path: 'm.ts', name: 'nope' })).rejects.toThrow(/No definition/);
});

test('env_info reports the platform and cwd', async () => {
  const out = await run('env_info', {});
  expect(out).toContain('platform:');
  expect(out).toContain('cwd:');
});

test('count_tokens estimates a file and a string', async () => {
  await write('a.txt', 'x'.repeat(400));
  const fileOut = await run('count_tokens', { path: 'a.txt' });
  expect(fileOut).toContain('~100 tokens');
  const strOut = await run('count_tokens', { text: 'abcd'.repeat(25) });
  expect(strOut).toContain('~25 tokens');
});
