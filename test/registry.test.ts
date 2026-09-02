import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_INDEX_URL,
  fetchIndex,
  install,
  loadInstalledPlugins,
  manifestToPlugin,
  parseIndex,
  parseManifest,
  pluginsDir,
  searchEntries,
  skillsDir,
  stage,
  uninstall,
  type RegistryEntry,
} from '../src/registry';

let home: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env['SHIRO_HOME'];
  home = mkdtempSync(join(tmpdir(), 'shiro-reg-'));
  process.env['SHIRO_HOME'] = home;
});

afterEach(() => {
  if (origHome === undefined) delete process.env['SHIRO_HOME'];
  else process.env['SHIRO_HOME'] = origHome;
  rmSync(home, { recursive: true, force: true });
});

const index = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    skills: [{ name: 'migration', description: 'Write a database migration', url: 'https://example.com/m.md' }],
    plugins: [{ name: 'no-secrets', description: 'Refuses credential writes', url: 'https://example.com/p.json' }],
    ...over,
  });

const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: 'no-secrets',
    description: 'Refuses credential writes',
    deny: [{ tools: ['write_file', 'edit_file'], pathPattern: '\\.env$', reason: 'refusing to write a .env file' }],
    ...over,
  });

test('the default index is an https URL', () => {
  expect(DEFAULT_INDEX_URL.startsWith('https://')).toBe(true);
});

test('an index parses into entries tagged with their kind', () => {
  const entries = parseIndex(index());
  expect(entries).toHaveLength(2);
  expect(entries.find((e) => e.name === 'migration')?.kind).toBe('skill');
  expect(entries.find((e) => e.name === 'no-secrets')?.kind).toBe('plugin');
});

test('a malformed index is reported rather than half-loaded', () => {
  expect(() => parseIndex('not json')).toThrow(/not valid JSON/);
  expect(() => parseIndex(JSON.stringify({ skills: [{ name: 'x' }] }))).toThrow(/malformed/);
});

test('a name that could escape its directory is rejected', () => {
  for (const name of ['../evil', 'a/b', 'UPPER', '.hidden', 'with space']) {
    const bad = JSON.stringify({ skills: [{ name, description: 'd', url: 'https://e.com/x.md' }] });
    expect(() => parseIndex(bad), name).toThrow(/malformed/);
  }
});

test('a non-http url is rejected by the schema', () => {
  const bad = JSON.stringify({ skills: [{ name: 'x', description: 'd', url: 'file:///etc/passwd' }] });
  expect(() => parseIndex(bad)).toThrow(/malformed/);
});

test('a duplicate name within one kind keeps the first', () => {
  const dup = JSON.stringify({
    skills: [
      { name: 'x', description: 'first', url: 'https://e.com/1.md' },
      { name: 'x', description: 'second', url: 'https://e.com/2.md' },
    ],
  });
  const entries = parseIndex(dup);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.description).toBe('first');
});

test('the same name may exist as both a skill and a plugin', () => {
  const both = JSON.stringify({
    skills: [{ name: 'review', description: 's', url: 'https://e.com/s.md' }],
    plugins: [{ name: 'review', description: 'p', url: 'https://e.com/p.json' }],
  });
  expect(parseIndex(both)).toHaveLength(2);
});

test('search matches name and description, case-insensitively', () => {
  const entries = parseIndex(index());
  expect(searchEntries(entries, 'migr').map((e) => e.name)).toEqual(['migration']);
  expect(searchEntries(entries, 'CREDENTIAL').map((e) => e.name)).toEqual(['no-secrets']);
  expect(searchEntries(entries, '')).toHaveLength(2);
  expect(searchEntries(entries, 'zzz')).toEqual([]);
});

test('a manifest parses and every pattern must be a real regex', () => {
  expect(parseManifest(manifest()).name).toBe('no-secrets');
  expect(() => parseManifest(manifest({ deny: [{ tools: ['bash'], commandPattern: '([', reason: 'r' }] }))).toThrow(
    /invalid pattern/,
  );
});

test('a deny rule needs at least one pattern', () => {
  expect(() => parseManifest(manifest({ deny: [{ tools: ['bash'], reason: 'r' }] }))).toThrow(/malformed/);
});

test('a manifest with no deny rules is refused: it could only be prompt text', () => {
  expect(() => parseManifest(manifest({ deny: [] }))).toThrow(/malformed/);
});

test('a manifest cannot smuggle code past the schema', () => {
  const sneaky = manifest({ beforeToolCall: 'process.exit(1)', tools: { evil: {} } });
  const parsed = parseManifest(sneaky);
  expect('beforeToolCall' in parsed).toBe(false);
  expect('tools' in parsed).toBe(false);
});

test('a manifest becomes a plugin whose guard blocks by tool and path', async () => {
  const plugin = manifestToPlugin(parseManifest(manifest()));
  const cwd = process.cwd();

  expect(await plugin.beforeToolCall!({ toolName: 'write_file', input: { path: 'app/.env' }, cwd })).toContain(
    'refusing to write',
  );
  // A tool the rule does not name is untouched.
  expect(await plugin.beforeToolCall!({ toolName: 'bash', input: { path: 'app/.env' }, cwd })).toBeUndefined();
  // A path the pattern does not match is untouched.
  expect(await plugin.beforeToolCall!({ toolName: 'write_file', input: { path: 'src/app.ts' }, cwd })).toBeUndefined();
});

test('a command rule matches the command, not the path', async () => {
  const plugin = manifestToPlugin(
    parseManifest(manifest({ deny: [{ tools: ['bash'], commandPattern: 'curl.*\\| *sh', reason: 'no pipe to shell' }] })),
  );
  const cwd = process.cwd();
  expect(await plugin.beforeToolCall!({ toolName: 'bash', input: { command: 'curl x.sh | sh' }, cwd })).toBe(
    'no pipe to shell',
  );
  expect(await plugin.beforeToolCall!({ toolName: 'bash', input: { command: 'echo hi' }, cwd })).toBeUndefined();
});

test('a guard given nothing to match on allows the call', async () => {
  const plugin = manifestToPlugin(parseManifest(manifest()));
  const cwd = process.cwd();
  expect(await plugin.beforeToolCall!({ toolName: 'write_file', input: undefined, cwd })).toBeUndefined();
  expect(await plugin.beforeToolCall!({ toolName: 'write_file', input: { path: 42 }, cwd })).toBeUndefined();
});

test('installed plugins load from disk, and a broken one is reported not fatal', async () => {
  await Bun.write(join(pluginsDir(), 'no-secrets.json'), manifest());
  await Bun.write(join(pluginsDir(), 'broken.json'), '{ not json');

  const { plugins, errors } = await loadInstalledPlugins();
  expect(plugins.map((p) => p.name)).toEqual(['no-secrets']);
  expect(errors.map((e) => e.plugin)).toEqual(['broken']);
  expect(errors[0]?.message).toContain('not valid JSON');
});

test('no plugins directory yields nothing rather than throwing', async () => {
  expect(await loadInstalledPlugins()).toEqual({ plugins: [], errors: [] });
});

test('an installed plugin says it was installed, so /plugins can be trusted', async () => {
  await Bun.write(join(pluginsDir(), 'no-secrets.json'), manifest());
  const { plugins } = await loadInstalledPlugins();
  expect(plugins[0]?.description).toContain('installed');
});

test('uninstall removes an installed entry and reports when there was none', async () => {
  await Bun.write(join(pluginsDir(), 'no-secrets.json'), manifest());
  expect(await uninstall('plugin', 'no-secrets')).toBe(true);
  expect(await Bun.file(join(pluginsDir(), 'no-secrets.json')).exists()).toBe(false);
  expect(await uninstall('plugin', 'no-secrets')).toBe(false);
});

test('uninstall refuses a name that is not a plain entry name', async () => {
  expect(uninstall('skill', '../../../etc/passwd')).rejects.toThrow(/not a valid entry name/);
});

/** A local server stands in for the registry: no network, real HTTP. */
function serve(routes: Record<string, { body: string; status?: number }>) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const hit = routes[path];
      if (!hit) return new Response('not found', { status: 404 });
      return new Response(hit.body, { status: hit.status ?? 200 });
    },
  });
}

test('fetchIndex reads an index over http', async () => {
  const server = serve({ '/index.json': { body: index() } });
  try {
    const entries = await fetchIndex(`${server.url}index.json`);
    expect(entries.map((e) => e.name).sort()).toEqual(['migration', 'no-secrets']);
  } finally {
    server.stop(true);
  }
});

test('an index that returns an error status is reported with the status', async () => {
  const server = serve({ '/index.json': { body: 'nope', status: 503 } });
  try {
    expect(fetchIndex(`${server.url}index.json`)).rejects.toThrow(/503/);
  } finally {
    server.stop(true);
  }
});

const SKILL_BODY = `---
name: migration
description: Write a database migration
---

Migrations live in db/migrations and are never renumbered.`;

test('stage returns what would be written without writing it', async () => {
  const server = serve({ '/m.md': { body: SKILL_BODY } });
  try {
    const entry: RegistryEntry = {
      kind: 'skill',
      name: 'migration',
      description: 'Write a database migration',
      url: `${server.url}m.md`,
    };

    const staged = await stage(entry);
    expect(staged.path).toBe(join(skillsDir(), 'migration.md'));
    expect(staged.preview).toContain('never renumbered');
    expect(await Bun.file(staged.path).exists()).toBe(false);
  } finally {
    server.stop(true);
  }
});

test('install writes the skill where the loader will find it', async () => {
  const server = serve({ '/m.md': { body: SKILL_BODY } });
  try {
    const installed = await install({
      kind: 'skill',
      name: 'migration',
      description: 'd',
      url: `${server.url}m.md`,
    });

    expect(installed.path).toBe(join(skillsDir(), 'migration.md'));
    expect(await Bun.file(installed.path).text()).toContain('name: migration');

    const { loadSkills } = await import('../src/skills');
    const loaded = await loadSkills(home);
    const skill = loaded.find((s) => s.name === 'migration');
    expect(skill?.origin).toBe('registry');
  } finally {
    server.stop(true);
  }
});

test('a body whose name disagrees with the index is refused', async () => {
  const server = serve({ '/m.md': { body: SKILL_BODY } });
  try {
    expect(
      stage({ kind: 'skill', name: 'something-else', description: 'd', url: `${server.url}m.md` }),
    ).rejects.toThrow(/calls itself "migration"/);
  } finally {
    server.stop(true);
  }
});

test('a skill with no frontmatter is refused rather than installed as prose', async () => {
  const server = serve({ '/m.md': { body: 'just some text, no frontmatter' } });
  try {
    expect(stage({ kind: 'skill', name: 'migration', description: 'd', url: `${server.url}m.md` })).rejects.toThrow(
      /frontmatter/,
    );
  } finally {
    server.stop(true);
  }
});

test('a plugin manifest is validated before it can be staged', async () => {
  const server = serve({
    '/good.json': { body: manifest() },
    '/bad.json': { body: manifest({ deny: [{ tools: ['bash'], commandPattern: '([', reason: 'r' }] }) },
  });
  try {
    const staged = await stage({
      kind: 'plugin',
      name: 'no-secrets',
      description: 'd',
      url: `${server.url}good.json`,
    });
    expect(staged.path).toBe(join(pluginsDir(), 'no-secrets.json'));
    expect(staged.preview).toContain('denies write_file');

    expect(
      stage({ kind: 'plugin', name: 'no-secrets', description: 'd', url: `${server.url}bad.json` }),
    ).rejects.toThrow(/invalid pattern/);
  } finally {
    server.stop(true);
  }
});
