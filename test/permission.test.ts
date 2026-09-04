import { expect, test } from 'bun:test';
import {
  DEFAULT_PERMISSIONS,
  Permissions,
  matchPattern,
  parsePermissions,
  resolve,
  subjectOf,
} from '../src/permission';

test('a bare * matches anything, including an empty subject', () => {
  expect(matchPattern('*', 'anything at all')).toBe(true);
  expect(matchPattern('*', '')).toBe(true);
});

test('* spans any characters, ? exactly one', () => {
  expect(matchPattern('git *', 'git status --porcelain')).toBe(true);
  expect(matchPattern('git *', 'gitstatus')).toBe(false);
  expect(matchPattern('src/?.ts', 'src/a.ts')).toBe(true);
  expect(matchPattern('src/?.ts', 'src/ab.ts')).toBe(false);
});

test('regex metacharacters in a pattern are literal', () => {
  // A rule written by a human. `.` must not match any character, or `*.env`
  // would also match `xxenv`.
  expect(matchPattern('*.env', 'config.env')).toBe(true);
  expect(matchPattern('*.env', 'configxenv')).toBe(false);
  expect(matchPattern('a+b', 'a+b')).toBe(true);
  expect(matchPattern('a+b', 'aab')).toBe(false);
});

test('* matches across newlines, since a bash command can contain one', () => {
  expect(matchPattern('git *', 'git commit -m "line one\nline two"')).toBe(true);
});

test('bash is matched on its command', () => {
  expect(subjectOf('bash', { command: 'git status' })).toBe('git status');
});

test('file tools are matched on their path', () => {
  for (const tool of ['read_file', 'write_file', 'edit_file', 'multi_edit', 'list_dir']) {
    expect(subjectOf(tool, { path: 'src/app.ts' }), tool).toBe('src/app.ts');
  }
});

test('a batch read is matched on every path it asks for', () => {
  const subject = subjectOf('read_many_files', { files: [{ path: 'a.ts' }, { path: 'b.ts' }] });
  // One subject per path, newline-separated so a path containing spaces stays whole.
  expect(subject).toBe('a.ts\nb.ts');
});

test('search tools are matched on the pattern, git_show on the ref', () => {
  expect(subjectOf('grep', { pattern: 'needle' })).toBe('needle');
  expect(subjectOf('glob', { pattern: 'src/**' })).toBe('src/**');
  expect(subjectOf('git_show', { ref: 'HEAD~2' })).toBe('HEAD~2');
});

test('a tool with no subject field yields undefined, not an empty string', () => {
  expect(subjectOf('git_status', {})).toBeUndefined();
  expect(subjectOf('bash', { notCommand: 'x' })).toBeUndefined();
  expect(subjectOf('bash', null)).toBeUndefined();
});

test('a plain decision applies to every call', () => {
  expect(resolve('allow', 'bash', { command: 'anything' }).decision).toBe('allow');
  expect(resolve('deny', 'bash', { command: 'anything' }).decision).toBe('deny');
});

test('no rules at all means ask', () => {
  expect(resolve(undefined, 'bash', { command: 'x' }).decision).toBe('ask');
});

test('the last matching rule wins, so a config reads top to bottom', () => {
  const rules = { '*': 'ask' as const, 'git *': 'allow' as const };
  expect(resolve(rules, 'bash', { command: 'git status' }).decision).toBe('allow');
  expect(resolve(rules, 'bash', { command: 'npm test' }).decision).toBe('ask');
});

test('the resolved pattern is reported, so the UI can say what decided', () => {
  const resolved = resolve({ '*': 'ask' as const, 'git *': 'allow' as const }, 'bash', { command: 'git log' });
  expect(resolved.pattern).toBe('git *');
});

test('a narrow allow after a broad deny is honoured', () => {
  // Default-deny with narrow allows is what a careful user writes, and it has to
  // be expressible. Refusals that must never be configurable live in the guard
  // plugin, which runs ahead of this.
  const rules = { '*': 'deny' as const, 'src/generated/*': 'allow' as const };
  expect(resolve(rules, 'edit_file', { path: 'src/generated/api.ts' }).decision).toBe('allow');
  expect(resolve(rules, 'edit_file', { path: 'src/app.ts' }).decision).toBe('deny');
});

test('a broad allow after a narrow deny wins, so order is the whole rule', () => {
  const denyFirst = { 'rm *': 'deny' as const, '*': 'allow' as const };
  const denyLast = { '*': 'allow' as const, 'rm *': 'deny' as const };
  expect(resolve(denyFirst, 'bash', { command: 'rm -rf build' }).decision).toBe('allow');
  expect(resolve(denyLast, 'bash', { command: 'rm -rf build' }).decision).toBe('deny');
});

test('a rule on a subject a tool does not have matches nothing but *', () => {
  const rules = { 'src/*': 'allow' as const };
  expect(resolve(rules, 'git_status', {}).decision).toBe('ask');
  expect(resolve({ '*': 'allow' as const }, 'git_status', {}).decision).toBe('allow');
});

test('one bad path in a batch read is enough to trigger a rule', () => {
  const rules = { '*': 'allow' as const, '*.env': 'deny' as const };
  const input = { files: [{ path: 'src/app.ts' }, { path: 'config/.env' }] };
  expect(resolve(rules, 'read_many_files', input).decision).toBe('deny');
});

test('the defaults let reads through and gate writes', () => {
  const p = new Permissions();
  expect(p.check('read_file', { path: 'src/app.ts' }).decision).toBe('allow');
  expect(p.check('grep', { pattern: 'x' }).decision).toBe('allow');
  expect(p.check('write_file', { path: 'src/app.ts' }).decision).toBe('ask');
  expect(p.check('edit_file', { path: 'src/app.ts' }).decision).toBe('ask');
  expect(p.check('multi_edit', { path: 'src/app.ts' }).decision).toBe('ask');
  expect(p.check('bash', { command: 'echo hi' }).decision).toBe('ask');
});

test('credentials are denied on read by default', () => {
  const p = new Permissions();
  expect(p.check('read_file', { path: '.env' }).decision).toBe('deny');
  expect(p.check('read_file', { path: 'config/.env.local' }).decision).toBe('deny');
  expect(p.check('read_file', { path: 'certs/key.pem' }).decision).toBe('deny');
  // The example file is the one that is safe to read, and it is the one a model
  // most often wants.
  expect(p.check('read_file', { path: '.env.example' }).decision).toBe('allow');
});

test('the git tools and session tools never gate', () => {
  const p = new Permissions();
  for (const tool of ['git_status', 'git_diff', 'git_log', 'todo_write', 'remember', 'skill']) {
    expect(p.check(tool, {}).decision, tool).toBe('allow');
  }
});

test('an unknown tool asks, which is what an MCP tool is', () => {
  const p = new Permissions();
  expect(p.check('mcp__fs__write', { path: 'x' }).decision).toBe('ask');
});

test('a wildcard tool key covers a family of tools', () => {
  const p = new Permissions({ config: { 'mcp__*': 'deny' } });
  expect(p.check('mcp__fs__read', {}).decision).toBe('deny');
  expect(p.check('read_file', { path: 'a.ts' }).decision).toBe('allow');
});

test('config for a tool replaces its defaults rather than merging', () => {
  // Otherwise a default deny could never be removed, which is the kind of
  // surprise that ends with the whole system switched off.
  const p = new Permissions({ config: { read_file: { '*': 'allow' } } });
  expect(p.check('read_file', { path: '.env' }).decision).toBe('allow');
});

test('yolo folds ask into allow and leaves deny alone', () => {
  const p = new Permissions({ yolo: true, config: { bash: { '*': 'ask', 'rm *': 'deny' } } });
  expect(p.check('bash', { command: 'echo hi' }).decision).toBe('allow');
  expect(p.check('bash', { command: 'rm -rf /' }).decision).toBe('deny');
});

test('yolo does not override a configured deny on reads either', () => {
  const p = new Permissions({ yolo: true });
  expect(p.check('read_file', { path: '.env' }).decision).toBe('deny');
});

test('autoApprove bypasses ask but not deny', () => {
  const p = new Permissions({ autoApprove: ['task', 'bash'], config: { bash: { '*': 'ask', 'rm *': 'deny' } } });
  expect(p.check('task', { description: 'search' }).decision).toBe('allow');
  expect(p.check('bash', { command: 'echo hi' }).decision).toBe('allow');
  expect(p.check('bash', { command: 'rm -rf /' }).decision).toBe('deny');
});

test('always suggests a command prefix for bash, not the whole command', () => {
  const p = new Permissions();
  expect(p.suggest('bash', { command: 'git status --porcelain' })).toBe('git *');
  expect(p.suggest('bash', { command: 'bun test' })).toBe('bun *');
});

test('always suggests the catch-all for anything but bash', () => {
  const p = new Permissions();
  // A path pattern guessed from one path is more often wrong than useful.
  expect(p.suggest('edit_file', { path: 'src/app.ts' })).toBe('*');
});

test('a granted pattern approves matching later calls only', () => {
  const p = new Permissions();
  p.grant('bash', 'git *');

  expect(p.check('bash', { command: 'git log' }).decision).toBe('allow');
  expect(p.check('bash', { command: 'git push' }).decision).toBe('allow');
  expect(p.check('bash', { command: 'npm publish' }).decision).toBe('ask');
});

test('a granted pattern is still bound by a later deny rule', () => {
  const p = new Permissions({ config: { bash: { '*': 'ask', 'rm *': 'deny' } } });
  p.grant('bash', '*');
  expect(p.check('bash', { command: 'rm -rf build' }).decision).toBe('deny');
  expect(p.check('bash', { command: 'echo hi' }).decision).toBe('allow');
});

test('parsePermissions keeps valid entries and drops the rest', () => {
  const parsed = parsePermissions({
    bash: 'allow',
    edit_file: { '*': 'ask', 'src/*': 'allow' },
    broken: 'maybe',
    alsoBroken: { 'src/*': 'perhaps' },
    notAnEntry: 42,
  });

  expect(parsed).toEqual({ bash: 'allow', edit_file: { '*': 'ask', 'src/*': 'allow' } });
});

test('a typo in a decision never widens access', () => {
  // "alow" is dropped, so the tool falls back to its default, which asks.
  const p = new Permissions({ config: parsePermissions({ bash: { '*': 'alow' } }) });
  expect(p.check('bash', { command: 'rm -rf /' }).decision).toBe('ask');
});

test('parsePermissions returns undefined for nothing usable', () => {
  expect(parsePermissions(undefined)).toBeUndefined();
  expect(parsePermissions('allow')).toBeUndefined();
  expect(parsePermissions({})).toBeUndefined();
  expect(parsePermissions({ bash: 'nonsense' })).toBeUndefined();
});

test('every mutating tool has a default, so none can be added without one', () => {
  const { MUTATING_TOOLS } = require('../src/tools') as { MUTATING_TOOLS: readonly string[] };
  for (const tool of MUTATING_TOOLS) {
    expect(DEFAULT_PERMISSIONS[tool], tool).toBeDefined();
  }
});
