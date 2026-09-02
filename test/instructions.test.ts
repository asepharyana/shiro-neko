import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatInstructions, INIT_PROMPT, loadInstructions } from '../src/instructions';
import { systemPrompt } from '../src/prompt';

let root: string;
let orig: string;

beforeEach(() => {
  orig = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'shiro-inst-'));
  mkdirSync(join(root, '.git'), { recursive: true });
  Bun.write(join(root, '.git', 'HEAD'), 'ref: refs/heads/main');
  process.chdir(root);
});

afterEach(() => {
  process.chdir(orig);
  rmSync(root, { recursive: true, force: true });
});

test('no instruction files yields an empty list and no prompt section', async () => {
  const found = await loadInstructions(root);
  expect(found).toEqual([]);
  expect(formatInstructions(found)).toBe('');
  expect(systemPrompt({ cwd: root, instructions: found })).not.toContain('Project instructions');
});

test('AGENTS.md at the root is loaded', async () => {
  await Bun.write(join(root, 'AGENTS.md'), '# Rules\nUse tabs, not spaces.\n');
  const found = await loadInstructions(root);
  expect(found).toHaveLength(1);
  expect(found[0]?.text).toContain('Use tabs, not spaces.');
});

test('the instruction text reaches the system prompt', async () => {
  await Bun.write(join(root, 'AGENTS.md'), 'Never touch generated/.\n');
  const prompt = systemPrompt({ cwd: root, instructions: await loadInstructions(root) });
  expect(prompt).toContain('Project instructions');
  expect(prompt).toContain('Never touch generated/.');
  expect(prompt).toContain('AGENTS.md');
});

test('CLAUDE.md and .shiro.md are recognised too', async () => {
  await Bun.write(join(root, 'CLAUDE.md'), 'claude rules\n');
  await Bun.write(join(root, '.shiro.md'), 'shiro rules\n');
  const names = (await loadInstructions(root)).map((i) => i.path.split(/[\\/]/).at(-1));
  expect(names).toEqual(['CLAUDE.md', '.shiro.md']);
});

test('files are collected from the git root down to cwd, outermost first', async () => {
  await Bun.write(join(root, 'AGENTS.md'), 'root rules\n');
  const nested = join(root, 'packages', 'api');
  mkdirSync(nested, { recursive: true });
  await Bun.write(join(nested, 'AGENTS.md'), 'api rules\n');

  const found = await loadInstructions(nested);
  expect(found.map((i) => i.text.trim())).toEqual(['root rules', 'api rules']);
});

test('the walk stops at the git root, ignoring files above it', async () => {
  const outside = join(root, '..', `outside-${Date.now()}.md`);
  await Bun.write(outside, 'should not be read');
  const nested = join(root, 'src');
  mkdirSync(nested, { recursive: true });
  await Bun.write(join(nested, 'AGENTS.md'), 'nested only\n');

  const found = await loadInstructions(nested);
  expect(found.map((i) => i.text.trim())).toEqual(['nested only']);
  rmSync(outside, { force: true });
});

test('an empty instruction file is skipped', async () => {
  await Bun.write(join(root, 'AGENTS.md'), '   \n\n');
  expect(await loadInstructions(root)).toEqual([]);
});

test('a huge instruction file is truncated so it cannot crowd out the conversation', async () => {
  await Bun.write(join(root, 'AGENTS.md'), 'x'.repeat(50_000));
  const found = await loadInstructions(root);
  expect(found[0]?.text.length).toBe(12_000);
});

test('the init prompt tells the model to verify rather than guess', () => {
  expect(INIT_PROMPT).toContain('AGENTS.md');
  expect(INIT_PROMPT).toContain('Investigate first');
  expect(INIT_PROMPT).toMatch(/no guesswork|not confirm|guesswork/i);
});
