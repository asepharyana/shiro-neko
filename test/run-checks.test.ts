import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { parseCommand } from '../src/commands';
import {
  docsCheckCommands,
  manifestScripts,
  runCheck,
  type CheckSuggestion,
} from '../src/tools-extra';

// Each test chdirs into a fresh temp dir so discovery sees only what the test wrote.
const tmp = (name: string) => `${Bun.env['TMPDIR'] ?? '/tmp'}/run-checks-${name}-${process.pid}`;
let cwd: string;

beforeEach(() => {
  cwd = process.cwd();
  const dir = tmp(`${Math.random().toString(36).slice(2)}`);
  // mkdtemp-style: create and chdir
  const { mkdirSync } = require('node:fs') as typeof import('node:fs');
  mkdirSync(dir, { recursive: true });
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(cwd);
});

describe('docsCheckCommands — AGENTS.md parsing', () => {
  it('extracts backticked commands', async () => {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(
      'AGENTS.md',
      '## Commands\n- `bun run typecheck` — typecheck\n- `bun test` — test suite\n',
    );
    const out = await docsCheckCommands(process.cwd());
    expect(out).toEqual([
      { name: 'typecheck', command: 'bun run typecheck', source: expect.stringContaining('AGENTS.md') },
      { name: 'test', command: 'bun test', source: expect.stringContaining('AGENTS.md') },
    ]);
  });

  it('ignores prose with no command and non-check commands', async () => {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync('AGENTS.md', 'Run the thing.\n- `bun run dev` — dev server\n- `bun run build`\n');
    const out = await docsCheckCommands(process.cwd());
    // build matches the check filter (`build` is one of the check words)
    expect(out.map((s) => s.command)).toContain('bun run build');
    expect(out.map((s) => s.command)).not.toContain('bun run dev');
    expect(out.length).toBeLessThanOrEqual(10);
  });

  it('only takes the first backticked span, not prose after it', async () => {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync('AGENTS.md', '- `bun test` — this is a description with a semicolon; run it\n');
    const out = await docsCheckCommands(process.cwd());
    expect(out[0]!.command).toBe('bun test'); // not "bun test — this is…"
  });

  it('handles $ -prefixed commands', async () => {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync('AGENTS.md', '```\n$ bun run typecheck\n```\n');
    const out = await docsCheckCommands(process.cwd());
    expect(out.map((s) => s.command)).toContain('bun run typecheck');
  });
});

describe('manifestScripts — package.json discovery', () => {
  it('finds scripts and uses bun when the lockfile is bun', async () => {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync('package.json', JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' } }));
    writeFileSync('bun.lock', '');
    const out = await manifestScripts(process.cwd());
    expect(out).toEqual([
      { name: 'test', command: 'bun run test', source: expect.stringContaining('package.json') },
      { name: 'lint', command: 'bun run lint', source: expect.stringContaining('package.json') },
    ]);
  });

  it('uses npm when there is no bun lockfile', async () => {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync('package.json', JSON.stringify({ scripts: { test: 'jest' } }));
    const out = await manifestScripts(process.cwd());
    expect(out[0]!.command).toBe('npm run test');
  });

  it('returns [] for a malformed manifest', async () => {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync('package.json', 'not json {');
    expect(await manifestScripts(process.cwd())).toEqual([]);
  });

  it('orders test, typecheck, check, lint, build first, then alphabetically', async () => {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync('package.json', JSON.stringify({ scripts: { zeta: '', lint: '', test: '' } }));
    const names = (await manifestScripts(process.cwd())).map((s) => s.name);
    expect(names[0]).toBe('test');
    expect(names[1]).toBe('lint');
    expect(names[2]).toBe('zeta');
  });
});

describe('runCheck — subprocess execution', () => {
  it('returns ok for exit 0', async () => {
    const r = await runCheck('node -e "process.exit(0)"', process.cwd(), 10_000);
    expect(r.ok).toBe(true);
  });

  it('returns fail for exit 1 with stderr surfaced', async () => {
    const r = await runCheck('node -e "console.error(\'boom\'); process.exit(1)"', process.cwd(), 10_000);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('boom');
  });

  it('times out a hanging command', async () => {
    const r = await runCheck('node -e "setTimeout(()=>{}, 60_000)"', process.cwd(), 500);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('timed out');
  });
});