import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommand } from '../src/commands';
import { expandCommand, loadCustomCommands, type CustomCommand } from '../src/custom-commands';

let dir: string;
let origCwd: string;
let origHome: string | undefined;

beforeEach(() => {
  origCwd = process.cwd();
  origHome = process.env['SHIRO_HOME'];
  dir = mkdtempSync(join(tmpdir(), 'shiro-cmd-'));
  process.chdir(dir);
  // An isolated home so a real ~/.shiro-neko/commands cannot leak into a test.
  const home = mkdtempSync(join(tmpdir(), 'shiro-home-'));
  process.env['SHIRO_HOME'] = home;
});

afterEach(() => {
  process.chdir(origCwd);
  if (origHome === undefined) delete process.env['SHIRO_HOME'];
  else process.env['SHIRO_HOME'] = origHome;
  rmSync(dir, { recursive: true, force: true });
});

const cmd = (over: Partial<CustomCommand>): CustomCommand => ({
  name: 'review-diff',
  description: 'review the current diff',
  body: 'Review the diff.',
  origin: 'project',
  path: '/x/review-diff.md',
  ...over,
});

test('a project command is discovered from .shiro/commands', async () => {
  await Bun.write(join('.shiro', 'commands', 'deploy.md'), '---\ndescription: ship it\n---\nDeploy the app.');
  const cmds = await loadCustomCommands(dir);
  expect(cmds.map((c) => c.name)).toContain('deploy');
  expect(cmds.find((c) => c.name === 'deploy')?.origin).toBe('project');
});

test('frontmatter supplies description and agent; the body is the prompt', async () => {
  await Bun.write(
    join('.shiro', 'commands', 'fix.md'),
    '---\ndescription: fix a test\nagent: deep\n---\nFix the failing test.',
  );
  const cmds = await loadCustomCommands(dir);
  const fix = cmds.find((c) => c.name === 'fix');
  expect(fix?.description).toBe('fix a test');
  expect(fix?.agent).toBe('deep');
  expect(fix?.body).toBe('Fix the failing test.');
});

test('a project command shadows a user command of the same name', async () => {
  const home = process.env['SHIRO_HOME']!;
  await Bun.write(join(home, '.shiro-neko', 'commands', 'go.md'), 'user version');
  await Bun.write(join('.shiro', 'commands', 'go.md'), 'project version');
  const cmds = await loadCustomCommands(dir);
  const go = cmds.find((c) => c.name === 'go');
  expect(go?.origin).toBe('project');
  expect(go?.body).toBe('project version');
});

test('an empty body or a bad filename is skipped', async () => {
  await Bun.write(join('.shiro', 'commands', 'empty.md'), '---\ndescription: nothing\n---\n   ');
  await Bun.write(join('.shiro', 'commands', 'BAD NAME.md'), 'not a valid command name');
  const cmds = await loadCustomCommands(dir);
  expect(cmds.map((c) => c.name)).not.toContain('empty');
  expect(cmds).toHaveLength(0);
});

test('the parser resolves a custom command and splits its arguments', () => {
  const action = parseCommand('/review-diff src/auth.ts', [cmd({})]);
  expect(action).toEqual({ type: 'custom', command: expect.objectContaining({ name: 'review-diff' }), args: ['src/auth.ts'] });
});

test('a custom command never shadows a built-in', () => {
  const action = parseCommand('/cost', [cmd({ name: 'cost', body: 'hijack' })]);
  expect(action.type).toBe('cost');
});

test('$ARGUMENTS and positionals expand', async () => {
  const c = cmd({ body: 'Review $1 against $2. All: $ARGUMENTS' });
  const out = await expandCommand(c, ['a.ts', 'b.ts']);
  expect(out).toBe('Review a.ts against b.ts. All: a.ts b.ts');
});

test('a missing positional expands to nothing', async () => {
  const c = cmd({ body: 'one $1 two $2 end' });
  expect(await expandCommand(c, ['only'])).toBe('one only two  end');
});

test('a shell substitution inlines its output', async () => {
  const c = cmd({ body: 'The branch is !`echo feature-x`.' });
  const out = await expandCommand(c, []);
  expect(out).toBe('The branch is feature-x.');
});

test('a destructive shell substitution is refused by the guard', async () => {
  const c = cmd({ body: 'run !`rm -rf /`' });
  await expect(expandCommand(c, [])).rejects.toThrow(/refused/i);
});

test('a failing substitution reports the command and exit', async () => {
  const c = cmd({ body: 'value: !`exit 3`' });
  await expect(expandCommand(c, [])).rejects.toThrow(/exited 3/);
});
