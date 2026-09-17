import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_SNAPSHOTS, relPath, restore, Snapshots, touchedPaths } from '../src/snapshot';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shiro-snap-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('relPath refuses anything outside the workspace', () => {
  expect(relPath(dir, join(dir, 'a.ts'))).toBe('a.ts');
  expect(relPath(dir, join(dir, 'sub', 'b.ts'))).toBe('sub/b.ts');
  expect(relPath(dir, join(dir, '..', 'escape.ts'))).toBeUndefined();
  expect(relPath(dir, dir)).toBeUndefined();
});

test('relPath uses forward slashes so a restore is portable', () => {
  expect(relPath(dir, join(dir, 'deep', 'nested', 'x.ts'))).toBe('deep/nested/x.ts');
});

test('touchedPaths names the file tools and their paths', () => {
  expect(touchedPaths('write_file', { path: 'a.ts' })).toEqual({ paths: ['a.ts'], covered: true });
  expect(touchedPaths('move_file', { from: 'a.ts', to: 'b.ts' })).toEqual({ paths: ['a.ts', 'b.ts'], covered: true });
  expect(touchedPaths('insert_lines', { path: 'a.ts' })).toEqual({ paths: ['a.ts'], covered: true });
});

test('touchedPaths reads every path out of a patch', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/a.ts',
    '@@',
    '-x',
    '+y',
    '*** Add File: src/b.ts',
    '+new',
    '*** Move to: src/c.ts',
    '*** End Patch',
  ].join('\n');

  const { paths, covered } = touchedPaths('apply_patch', { patch });
  expect(covered).toBe(true);
  expect(paths).toContain('src/a.ts');
  expect(paths).toContain('src/b.ts');
  expect(paths).toContain('src/c.ts');
});

test('bash is reported as uncovered because it can write anything', () => {
  expect(touchedPaths('bash', { command: 'rm -rf src' })).toEqual({ paths: [], covered: false });
});

test('a read tool touches nothing and is covered', () => {
  expect(touchedPaths('read_file', { path: 'a.ts' })).toEqual({ paths: [], covered: true });
});

test('a turn records the pre-image of a file it changes', async () => {
  await Bun.write(join(dir, 'a.ts'), 'original');
  const snaps = new Snapshots(dir);

  snaps.begin('change a', 3);
  await snaps.capture(join(dir, 'a.ts'));
  await Bun.write(join(dir, 'a.ts'), 'changed');

  const snap = snaps.commit();
  expect(snap).toBeDefined();
  expect(snap!.files).toEqual([{ path: 'a.ts', before: 'original' }]);
  expect(snap!.messageCount).toBe(3);
});

test('the first write of a turn wins, so undo restores the turn start not the midpoint', async () => {
  await Bun.write(join(dir, 'a.ts'), 'v0');
  const snaps = new Snapshots(dir);

  snaps.begin('two writes', 0);
  await snaps.capture(join(dir, 'a.ts'));
  await Bun.write(join(dir, 'a.ts'), 'v1');
  await snaps.capture(join(dir, 'a.ts'));
  await Bun.write(join(dir, 'a.ts'), 'v2');

  const snap = snaps.commit()!;
  expect(snap.files[0]!.before).toBe('v0');
  expect(await Bun.file(join(dir, 'a.ts')).text()).toBe('v2');
});

test('a file that did not exist is recorded as created', async () => {
  const snaps = new Snapshots(dir);
  snaps.begin('create', 0);
  await snaps.capture(join(dir, 'new.ts'));
  snaps.commit();

  const snap = snaps.pop()!;
  expect(snap.files).toEqual([{ path: 'new.ts', before: undefined }]);
});

test('a turn that changed nothing is not kept', () => {
  const snaps = new Snapshots(dir);
  snaps.begin('a question', 0);
  expect(snaps.commit()).toBeUndefined();
  expect(snaps.size).toBe(0);
});

test('a path outside the workspace is not captured', async () => {
  const snaps = new Snapshots(dir);
  snaps.begin('escape', 0);
  await snaps.capture(join(dir, '..', 'outside.ts'));
  expect(snaps.commit()).toBeUndefined();
});

test('captureFor pulls the paths out of the tool call', async () => {
  await Bun.write(join(dir, 'a.ts'), 'before');
  const snaps = new Snapshots(dir);
  snaps.begin('edit', 0);

  const { covered, paths } = await snaps.captureFor('edit_file', { path: 'a.ts' });
  expect(covered).toBe(true);
  expect(paths).toEqual(['a.ts']);
  expect(snaps.commit()!.files[0]!.before).toBe('before');
});

test('only the most recent snapshots are kept', async () => {
  const snaps = new Snapshots(dir);
  for (let i = 0; i < MAX_SNAPSHOTS + 10; i++) {
    snaps.begin(`turn ${i}`, 0);
    await snaps.captureFor('write_file', { path: `f${i}.ts` });
    snaps.commit();
  }
  expect(snaps.size).toBe(MAX_SNAPSHOTS);
  // The oldest are the ones that fell off.
  expect(snaps.list().at(-1)!.turn).toBe(11);
});

test('restore writes content back and removes a file the turn created', async () => {
  await Bun.write(join(dir, 'edited.ts'), 'changed');
  await Bun.write(join(dir, 'created.ts'), 'was not here before');

  const snap = {
    turn: 1,
    at: new Date().toISOString(),
    prompt: 'p',
    messageCount: 0,
    files: [
      { path: 'edited.ts', before: 'original' },
      { path: 'created.ts', before: undefined },
    ],
  };

  const { restored, removed } = await restore(snap, dir);
  expect(restored).toEqual(['edited.ts']);
  expect(removed).toEqual(['created.ts']);
  expect(await Bun.file(join(dir, 'edited.ts')).text()).toBe('original');
  expect(await Bun.file(join(dir, 'created.ts')).exists()).toBe(false);
});

test('restore recreates a file that the turn deleted', async () => {
  const snap = {
    turn: 1,
    at: new Date().toISOString(),
    prompt: 'p',
    messageCount: 0,
    files: [{ path: 'gone.ts', before: 'the content' }],
  };

  await restore(snap, dir);
  expect(await Bun.file(join(dir, 'gone.ts')).text()).toBe('the content');
});

test('pop and push move a turn out and back for redo', async () => {
  await Bun.write(join(dir, 'a.ts'), 'orig');
  const snaps = new Snapshots(dir);
  snaps.begin('edit', 0);
  await snaps.capture(join(dir, 'a.ts'));
  const committed = snaps.commit()!;

  const popped = snaps.pop()!;
  expect(popped.turn).toBe(committed.turn);
  expect(snaps.size).toBe(0);

  snaps.push(popped);
  expect(snaps.size).toBe(1);
});

test('a discard drops the open turn without recording it', () => {
  const snaps = new Snapshots(dir);
  snaps.begin('aborted', 0);
  snaps.discard();
  expect(snaps.open).toBe(false);
  expect(snaps.size).toBe(0);
});

test('an unreadable path does not break the snapshot', async () => {
  const snaps = new Snapshots(dir);
  snaps.begin('odd', 0);
  // A directory, not a file: reading it as text fails, and the capture must swallow that.
  await snaps.capture(dir);
  expect(snaps.open).toBe(true);
});
