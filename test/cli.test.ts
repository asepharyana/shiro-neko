import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '../src/version';

/**
 * The CLI entry point is an executable, not a module: importing it parses argv,
 * loads config, connects MCP, and renders Ink. Nothing in `test/` imports it for
 * that reason, and its flag surface was previously exercised only by hand.
 *
 * So it is tested the way a user meets it — by running the real entry point in a
 * child process — with two things held constant. `SHIRO_HOME` points at a scratch
 * directory, and every API-key variable is stripped, so the "no key" branches are
 * deterministic rather than accidentally satisfied by the developer's shell. The
 * entry is invoked by absolute path from a scratch cwd, so the repository's own
 * `config.json`, `AGENTS.md`, and `.shiro/` entries stay out of the run.
 *
 * Only paths that exit before `render()` are covered; anything past it needs a
 * TTY. That still reaches every argument-parsing decision, which is the point.
 */

const ROOT = join(import.meta.dir, '..');
const ENTRY = join(ROOT, 'src', 'cli.tsx');

/** Credential variables that would otherwise decide `cfg.apiKey` for us. */
const KEY_VARS = [
  'SHIRO_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'SHIRO_PROVIDER',
  'SHIRO_MODEL',
  'SHIRO_BASE_URL',
];

let home: string;
let scratch: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'shiro-cli-home-'));
  scratch = mkdtempSync(join(tmpdir(), 'shiro-cli-cwd-'));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

function cleanEnv(shiroHome: string): Record<string, string> {
  // Bun.spawn's `env` replaces the environment, so start from a copy of ours and
  // remove the credentials rather than hand-assembling a minimal one.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of KEY_VARS) delete env[k];
  env['SHIRO_HOME'] = shiroHome;
  return env;
}

async function cli(args: string[], shiroHome = home): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn([process.execPath, ENTRY, ...args], {
    cwd: scratch,
    env: cleanEnv(shiroHome),
    // /dev/null, so `readStdin` sees EOF instead of blocking on a pipe nobody closes.
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

test('--help prints usage and exits 0', async () => {
  const { stdout, code } = await cli(['--help']);
  expect(code).toBe(0);
  expect(stdout).toContain('usage: shiro');
  expect(stdout).toContain('--yolo');
  expect(stdout).toContain('--print');
  expect(stdout).toContain('--agent');
});

test('-h is the same as --help', async () => {
  const { stdout, code } = await cli(['-h']);
  expect(code).toBe(0);
  expect(stdout).toContain('usage: shiro');
});

test('--version prints the version line and exits 0', async () => {
  const { stdout, code } = await cli(['--version']);
  expect(code).toBe(0);
  expect(stdout).toContain(`shiro-neko ${VERSION}`);
  expect(stdout).toContain(process.platform);
});

test('-v is the same as --version', async () => {
  const { stdout, code } = await cli(['-v']);
  expect(code).toBe(0);
  expect(stdout).toContain(`shiro-neko ${VERSION}`);
});

test('an unknown --agent fails with the valid list', async () => {
  const { stderr, code } = await cli(['--agent', 'turbo']);
  expect(code).toBe(1);
  expect(stderr).toContain('Unknown agent "turbo"');
  expect(stderr).toContain('default, quick, deep, plan, review');
});

test('an unknown --think fails with the valid list', async () => {
  const { stderr, code } = await cli(['--think', 'turbo']);
  expect(code).toBe(1);
  expect(stderr).toContain('Unknown thinking level "turbo"');
  expect(stderr).toContain('off, low, medium, high, max');
});

test('-p without a key refuses to run headless', async () => {
  const { stderr, code } = await cli(['-p', 'hello']);
  expect(code).toBe(1);
  expect(stderr).toContain('No API key for provider "anthropic"');
});

test('--resume with no matching session fails', async () => {
  const { stderr, code } = await cli(['-r', 'nosuchid']);
  expect(code).toBe(1);
  expect(stderr).toContain('no session matching "nosuchid"');
});

test('--continue with no saved session fails', async () => {
  const { stderr, code } = await cli(['-c']);
  expect(code).toBe(1);
  expect(stderr).toContain('no saved session for this directory');
});

test('a configured key with no prompt and no stdin reports the missing prompt', async () => {
  // A second home, so the key file this writes does not leak into the tests above.
  const keyed = mkdtempSync(join(tmpdir(), 'shiro-cli-keyed-'));
  try {
    mkdirSync(join(keyed, '.shiro-neko'), { recursive: true });
    await Bun.write(
      join(keyed, '.shiro-neko', 'config.json'),
      `${JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-test' }, null, 2)}\n`,
    );
    // The full isolation flag set is passed so this also proves they all parse and
    // the module boots with them; with an empty stdin, `-p` must report the prompt.
    const { stderr, code } = await cli(
      ['-p', '--no-plugins', '--no-skills', '--no-memory', '--no-instructions', '--no-mcp', '--no-subagent'],
      keyed,
    );
    expect(code).toBe(1);
    expect(stderr).toContain('needs a prompt');
  } finally {
    rmSync(keyed, { recursive: true, force: true });
  }
});
