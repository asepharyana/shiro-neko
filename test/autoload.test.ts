import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadExternalPlugins, loadExternalTools, parseToolManifest, manifestToTool } from '../src/autoload';

let cwd: string;
let home: string;
let origCwd: string;
let origHome: string | undefined;

beforeEach(() => {
  origCwd = process.cwd();
  origHome = process.env['SHIRO_HOME'];
  cwd = mkdtempSync(join(tmpdir(), 'shiro-auto-'));
  home = mkdtempSync(join(tmpdir(), 'shiro-autohome-'));
  process.chdir(cwd);
  process.env['SHIRO_HOME'] = home;
});

afterEach(() => {
  process.chdir(origCwd);
  if (origHome === undefined) delete process.env['SHIRO_HOME'];
  else process.env['SHIRO_HOME'] = origHome;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const noGuard = async () => undefined;
const denyAll = async () => 'not allowed';

test('a tool manifest validates its kind-specific field', () => {
  expect(() => parseToolManifest('{"name":"x","description":"d","kind":"shell"}')).toThrow(/needs a command/);
  expect(() => parseToolManifest('{"name":"x","description":"d","kind":"http"}')).toThrow(/needs a url/);
  expect(() => parseToolManifest('{"name":"x","description":"d","kind":"read"}')).toThrow(/needs a path/);
  expect(parseToolManifest('{"name":"x","description":"d","kind":"shell","command":"echo hi"}').name).toBe('x');
});

test('a malformed manifest is a descriptive error, not a crash', () => {
  expect(() => parseToolManifest('not json')).toThrow(/not valid JSON/);
  expect(() => parseToolManifest('{"name":"x"}')).toThrow(/malformed/);
});

test('an external read tool returns a workspace file, jailed', async () => {
  await Bun.write('note.txt', 'hello workspace');
  const t = manifestToTool(parseToolManifest('{"name":"rd","description":"d","kind":"read","path":"note.txt"}'), noGuard);
  const out = (await t.execute!({ arg: '' }, { toolCallId: 't', messages: [] } as never)) as string;
  expect(out).toBe('hello workspace');
});

test('a read tool cannot escape the workspace', async () => {
  const t = manifestToTool(
    parseToolManifest('{"name":"rd","description":"d","kind":"read","path":"../../secret"}'),
    noGuard,
  );
  await expect(t.execute!({ arg: '' }, { toolCallId: 't', messages: [] } as never)).rejects.toThrow();
});

test('an external shell tool substitutes {arg} and runs it', async () => {
  const t = manifestToTool(
    parseToolManifest('{"name":"hi","description":"d","kind":"shell","command":"echo got-{arg}"}'),
    noGuard,
  );
  const out = (await t.execute!({ arg: 'there' }, { toolCallId: 't', messages: [] } as never)) as string;
  expect(out).toBe('got-there');
});

test('a shell tool is stopped by the guard before it runs', async () => {
  const t = manifestToTool(
    parseToolManifest('{"name":"bad","description":"d","kind":"shell","command":"echo should-not-run"}'),
    denyAll,
  );
  await expect(t.execute!({ arg: '' }, { toolCallId: 't', messages: [] } as never)).rejects.toThrow(/refused/);
});

test('an http tool refuses a non-https URL', async () => {
  const t = manifestToTool(
    parseToolManifest('{"name":"w","description":"d","kind":"http","url":"http://insecure.example/x"}'),
    noGuard,
  );
  await expect(t.execute!({ arg: '' }, { toolCallId: 't', messages: [] } as never)).rejects.toThrow(/https/);
});

test('loadExternalTools auto-registers a project tool and marks it auto-approved', async () => {
  await Bun.write(join('.shiro', 'tools', 'greet.json'), '{"name":"greet","description":"d","kind":"shell","command":"echo hi"}');
  const { tools, autoApprove, errors } = await loadExternalTools(cwd, noGuard);
  expect(Object.keys(tools)).toContain('greet');
  expect(autoApprove).toContain('greet');
  expect(errors).toHaveLength(0);
});

test('a tool with autoApprove:false is registered but not auto-approved', async () => {
  await Bun.write(
    join('.shiro', 'tools', 'deploy.json'),
    '{"name":"deploy","description":"d","kind":"shell","command":"echo deploy","autoApprove":false}',
  );
  const { tools, autoApprove } = await loadExternalTools(cwd, noGuard);
  expect(Object.keys(tools)).toContain('deploy');
  expect(autoApprove).not.toContain('deploy');
});

test('a bad tool file is reported and skipped, never fatal', async () => {
  await Bun.write(join('.shiro', 'tools', 'broken.json'), '{ not json');
  await Bun.write(join('.shiro', 'tools', 'good.json'), '{"name":"good","description":"d","kind":"read","path":"x.txt"}');
  const { tools, errors } = await loadExternalTools(cwd, noGuard);
  expect(Object.keys(tools)).toContain('good');
  expect(errors).toHaveLength(1);
  expect(errors[0]!.name).toBe('broken');
});

test('an external plugin manifest auto-loads and blocks a matching call', async () => {
  await Bun.write(
    join('.shiro', 'plugins', 'no-drop.json'),
    JSON.stringify({
      name: 'no-drop',
      description: 'never drop a table',
      deny: [{ tools: ['bash'], commandPattern: 'DROP TABLE', reason: 'drops data' }],
    }),
  );
  const { plugins, errors } = await loadExternalPlugins(cwd);
  expect(errors).toHaveLength(0);
  expect(plugins.map((p) => p.name)).toContain('no-drop');
  const blocked = await plugins[0]!.beforeToolCall!({ toolName: 'bash', input: { command: 'DROP TABLE users' }, cwd });
  expect(blocked).toBe('drops data');
});

test('a bad plugin file is reported and skipped', async () => {
  await Bun.write(join('.shiro', 'plugins', 'bad.json'), '{"name":"bad"}');
  const { plugins, errors } = await loadExternalPlugins(cwd);
  expect(plugins).toHaveLength(0);
  expect(errors).toHaveLength(1);
});
