import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bashTool,
  editFileTool,
  globTool,
  grepTool,
  jail,
  onBashOutput,
  readFileTool,
  writeFileTool,
} from '../src/tools';

let dir: string;
let origCwd: string;

/** Tools resolve paths against process.cwd(), so each test runs inside a temp workspace. */
beforeEach(() => {
  origCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'shiro-'));
  process.chdir(dir);
});

afterEach(() => {
  onBashOutput(undefined);
  process.chdir(origCwd);
  rmSync(dir, { recursive: true, force: true });
});

const run = <T>(t: { execute?: (input: T, opts: any) => unknown }, input: T) =>
  Promise.resolve(t.execute!(input, { toolCallId: 't1', messages: [] })) as Promise<string>;

test('jail rejects traversal and absolute escapes', () => {
  expect(() => jail('../secret')).toThrow(/escapes workspace/);
  expect(() => jail('a/../../secret')).toThrow(/escapes workspace/);
  expect(jail('a/b.ts')).toBe(join(process.cwd(), 'a', 'b.ts'));
});

test('read_file numbers lines and honours offset/limit', async () => {
  await Bun.write(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  expect(await run(readFileTool, { path: 'a.txt' })).toBe('1: one\n2: two\n3: three\n4: ');
  expect(await run(readFileTool, { path: 'a.txt', offset: 2, limit: 1 })).toBe('2: two');
});

test('read_file on missing path throws', async () => {
  expect(run(readFileTool, { path: 'nope.txt' })).rejects.toThrow(/No such file/);
});

test('read_file refuses a binary file instead of dumping mojibake', async () => {
  await Bun.write(join(dir, 'blob.bin'), new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x03]));
  expect(run(readFileTool, { path: 'blob.bin' })).rejects.toThrow(/binary file/);
});

test('read_file still accepts UTF-8 with high codepoints', async () => {
  await Bun.write(join(dir, 'u.txt'), 'hello -> world\n');
  expect(await run(readFileTool, { path: 'u.txt' })).toContain('hello -> world');
});

test('edit_file replaces a unique occurrence', async () => {
  await Bun.write(join(dir, 'x.ts'), 'const a = 1;\nconst b = 2;\n');
  await run(editFileTool, { path: 'x.ts', oldString: 'const b = 2;', newString: 'const b = 3;' });
  expect(await Bun.file(join(dir, 'x.ts')).text()).toBe('const a = 1;\nconst b = 3;\n');
});

test('edit_file refuses ambiguous oldString unless replaceAll', async () => {
  await Bun.write(join(dir, 'y.ts'), 'x\nx\n');
  expect(run(editFileTool, { path: 'y.ts', oldString: 'x', newString: 'z' })).rejects.toThrow(/appears 2 times/);

  await run(editFileTool, { path: 'y.ts', oldString: 'x', newString: 'z', replaceAll: true });
  expect(await Bun.file(join(dir, 'y.ts')).text()).toBe('z\nz\n');
});

test('edit_file reports a missing oldString', async () => {
  await Bun.write(join(dir, 'z.ts'), 'hello');
  expect(run(editFileTool, { path: 'z.ts', oldString: 'bye', newString: 'hi' })).rejects.toThrow(/not found/);
});

test('write_file then glob and grep find the content', async () => {
  await run(writeFileTool, { path: 'src/app.ts', content: 'export const port = 8080;\n' });
  expect(await run(globTool, { pattern: 'src/**/*.ts' })).toBe('src/app.ts');
  expect(await run(grepTool, { pattern: 'port = \\d+', include: '**/*.ts' })).toBe(
    'src/app.ts:1: export const port = 8080;',
  );
});

test('glob skips gitignored paths and honours includeIgnored', async () => {
  await Bun.write(join(dir, '.gitignore'), 'dist/\n');
  await Bun.write(join(dir, 'dist/app.js'), 'x');
  await Bun.write(join(dir, 'src/app.js'), 'x');

  expect(await run(globTool, { pattern: '**/*.js' })).toBe('src/app.js');
  const both = await run(globTool, { pattern: '**/*.js', includeIgnored: true });
  expect(both.split('\n').sort()).toEqual(['dist/app.js', 'src/app.js']);
});

test('grep skips gitignored paths and honours includeIgnored', async () => {
  await Bun.write(join(dir, '.gitignore'), 'vendor/\n');
  await Bun.write(join(dir, 'vendor/lib.ts'), 'const needle = 1;\n');
  await Bun.write(join(dir, 'src/own.ts'), 'const needle = 2;\n');

  const clean = await run(grepTool, { pattern: 'needle' });
  expect(clean).toContain('src/own.ts');
  expect(clean).not.toContain('vendor/lib.ts');

  const all = await run(grepTool, { pattern: 'needle', includeIgnored: true });
  expect(all).toContain('vendor/lib.ts');
});

test('grep skips binaries', async () => {
  await Bun.write(join(dir, 'blob.bin'), new Uint8Array([0x00, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]));
  await Bun.write(join(dir, 'code.ts'), 'needle\n');
  const out = await run(grepTool, { pattern: 'needle' });
  expect(out).toContain('code.ts');
  expect(out).not.toContain('blob.bin');
});

test('grep honours ignoreCase', async () => {
  await Bun.write(join(dir, 'c.ts'), 'NEEDLE\n');
  expect(await run(grepTool, { pattern: 'needle' })).toBe('No matches.');
  expect(await run(grepTool, { pattern: 'needle', ignoreCase: true })).toContain('c.ts:1: NEEDLE');
});

test('grep reports no matches rather than an empty string', async () => {
  await Bun.write(join(dir, 'a.ts'), 'nothing here\n');
  expect(await run(grepTool, { pattern: 'zzzznope' })).toBe('No matches.');
});

test('grep rejects an invalid regex instead of crashing the loop', async () => {
  await Bun.write(join(dir, 'a.ts'), 'x\n');
  expect(run(grepTool, { pattern: '([' })).rejects.toThrow(/Invalid regex/);
});

test('bash returns the exit code and captured output', async () => {
  const out = await run(bashTool, { command: 'echo hello' });
  expect(out).toContain('exit: 0');
  expect(out).toContain('hello');
});

test('bash reports a non-zero exit code', async () => {
  const out = await run(bashTool, { command: 'exit 3' });
  expect(out).toContain('exit: 3');
});

test('bash streams output to the listener before the command exits', async () => {
  const chunks: { id: string; text: string }[] = [];
  onBashOutput(({ toolCallId, chunk }) => chunks.push({ id: toolCallId, text: chunk }));

  const script =
    process.platform === 'win32'
      ? 'echo first && ping -n 2 127.0.0.1 > nul && echo second'
      : 'echo first; sleep 0.4; echo second';
  await run(bashTool, { command: script });

  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.every((c) => c.id === 't1')).toBe(true);
  const streamed = chunks.map((c) => c.text).join('');
  expect(streamed).toContain('first');
  expect(streamed).toContain('second');
}, 20_000);

test('the bash listener is cleared when unset', async () => {
  const chunks: string[] = [];
  onBashOutput(({ chunk }) => chunks.push(chunk));
  await run(bashTool, { command: 'echo one' });
  const afterFirst = chunks.length;

  onBashOutput(undefined);
  await run(bashTool, { command: 'echo two' });
  expect(chunks.length).toBe(afterFirst);
}, 20_000);
