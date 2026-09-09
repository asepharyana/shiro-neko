import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hashFile,
  loadApprovalStore,
  loadHooks,
  parseHookManifest,
  runPreTool,
  hooksToPlugin,
} from '../src/hooks';
import { createHost } from '../src/plugins';

function inTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'shiro-hooks-'));
  const orig = process.env['SHIRO_HOME'];
  process.env['SHIRO_HOME'] = dir;
  return fn(dir).finally(() => {
    process.env['SHIRO_HOME'] = orig;
    rmSync(dir, { recursive: true, force: true });
  });
}

/** A pre_tool hook that allows everything and echoes the input back. */
const ALLOW_HOOK = `#!/usr/bin/env node
const input = require('fs').readFileSync(0, 'utf8');
console.log(JSON.stringify({ allow: true }));
`;

/** A pre_tool hook that refuses. */
const BLOCK_HOOK = `#!/usr/bin/env node
console.log(JSON.stringify({ allow: false, reason: 'no writes in this repo' }));
`;

test('parseHookManifest accepts a valid manifest and rejects a bad one', () => {
  const m = parseHookManifest(JSON.stringify({ name: 'no-force', hook: 'pre_tool', tools: ['bash'] }));
  expect(m.name).toBe('no-force');
  expect(m.hook).toBe('pre_tool');
  expect(() => parseHookManifest('not json')).toThrow('not valid JSON');
  expect(() => parseHookManifest(JSON.stringify({ name: 'X', hook: 'nope' }))).toThrow('malformed');
});

test('loadHooks finds a directory hook and hashes its executable', () =>
  inTmp(async (dir) => {
    const hookDir = join(dir, '.shiro', 'hooks', 'no-force');
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(join(hookDir, 'manifest.json'), JSON.stringify({ name: 'no-force', hook: 'pre_tool' }));
    writeFileSync(join(hookDir, 'run'), ALLOW_HOOK);
    const hooks = await loadHooks(dir);
    expect(hooks.length).toBe(1);
    expect(hooks[0]!.manifest.name).toBe('no-force');
    expect(hooks[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashFile(hooks[0]!.path)).toBe(hooks[0]!.hash);
  }));

test('an unapproved hook blocks the call', () =>
  inTmp(async (dir) => {
    const hookDir = join(dir, '.shiro', 'hooks', 'no-force');
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(join(hookDir, 'manifest.json'), JSON.stringify({ name: 'no-force', hook: 'pre_tool' }));
    writeFileSync(join(hookDir, 'run'), BLOCK_HOOK);
    const hooks = await loadHooks(dir);
    const store = loadApprovalStore(); // empty store → nothing approved
    const plugin = hooksToPlugin(hooks, store);
    const blocked = await plugin.beforeToolCall?.({ toolName: 'bash', input: { command: 'rm -rf /' }, cwd: dir });
    expect(blocked).toContain('has not been approved');
  }));

test('an approved blocking hook refuses the call with its reason', () =>
  inTmp(async (dir) => {
    const hookDir = join(dir, '.shiro', 'hooks', 'no-force');
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(join(hookDir, 'manifest.json'), JSON.stringify({ name: 'no-force', hook: 'pre_tool' }));
    writeFileSync(join(hookDir, 'run'), BLOCK_HOOK);
    const hooks = await loadHooks(dir);
    const store = loadApprovalStore();
    store.approve(hooks[0]!.hash);
    const plugin = hooksToPlugin(hooks, store);
    const blocked = await plugin.beforeToolCall?.({ toolName: 'bash', input: { command: 'rm -rf /' }, cwd: dir });
    expect(blocked).toContain('no writes in this repo');
  }));

test('an approved allowing hook lets the call through', () =>
  inTmp(async (dir) => {
    const hookDir = join(dir, '.shiro', 'hooks', 'allow');
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(join(hookDir, 'manifest.json'), JSON.stringify({ name: 'allow', hook: 'pre_tool' }));
    writeFileSync(join(hookDir, 'run'), ALLOW_HOOK);
    const hooks = await loadHooks(dir);
    const store = loadApprovalStore();
    store.approve(hooks[0]!.hash);
    const plugin = hooksToPlugin(hooks, store);
    const allowed = await plugin.beforeToolCall?.({ toolName: 'bash', input: { command: 'ls' }, cwd: dir });
    expect(allowed).toBeUndefined();
  }));

test('a changed hash is refused until re-approved', () =>
  inTmp(async (dir) => {
    const hookDir = join(dir, '.shiro', 'hooks', 'no-force');
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(join(hookDir, 'manifest.json'), JSON.stringify({ name: 'no-force', hook: 'pre_tool' }));
    writeFileSync(join(hookDir, 'run'), BLOCK_HOOK);
    const first = await loadHooks(dir);
    const store = loadApprovalStore();
    store.approve(first[0]!.hash);
    // file changes → hash changes → approval no longer matches
    writeFileSync(join(hookDir, 'run'), ALLOW_HOOK);
    const second = await loadHooks(dir);
    const plugin = hooksToPlugin(second, store);
    const blocked = await plugin.beforeToolCall?.({ toolName: 'bash', input: { command: 'ls' }, cwd: dir });
    expect(blocked).toContain('has not been approved');
  }));

test('an invalid hook is skipped, not fatal', () =>
  inTmp(async (dir) => {
    const hookDir = join(dir, '.shiro', 'hooks', 'broken');
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(join(hookDir, 'manifest.json'), 'not json');
    writeFileSync(join(hookDir, 'run'), '#!/bin/sh\nexit 0\n');
    const hooks = await loadHooks(dir);
    expect(hooks.length).toBe(0);
  }));

test('an approving hook runs in the guard chain', () =>
  inTmp(async (dir) => {
    const hookDir = join(dir, '.shiro', 'hooks', 'allow');
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(join(hookDir, 'manifest.json'), JSON.stringify({ name: 'allow', hook: 'pre_tool' }));
    writeFileSync(join(hookDir, 'run'), ALLOW_HOOK);
    const hooks = await loadHooks(dir);
    const store = loadApprovalStore();
    store.approve(hooks[0]!.hash);
    const host = createHost([hooksToPlugin(hooks, store)]);
    const blocked = await host.guard({ toolName: 'bash', input: { command: 'ls' }, cwd: dir });
    expect(blocked).toBeUndefined();
  }));

test('a bad hook output blocks the call', () =>
  inTmp(async (dir) => {
    const hookDir = join(dir, '.shiro', 'hooks', 'bad');
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(join(hookDir, 'manifest.json'), JSON.stringify({ name: 'bad', hook: 'pre_tool' }));
    writeFileSync(join(hookDir, 'run'), '#!/usr/bin/env node\nconsole.log("not json");\n');
    const hooks = await loadHooks(dir);
    const store = loadApprovalStore();
    store.approve(hooks[0]!.hash);
    const outcome = await runPreTool(hooks[0]!, { toolName: 'bash', input: { command: 'ls' }, cwd: dir }, 5000);
    expect(outcome.allow).toBe(false);
  }));