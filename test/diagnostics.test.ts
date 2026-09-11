import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { diagStart, diagStop, diagStatus, bootDiagnostics, defaultDiagnosticsCommand, shutdownDiagnostics } from '../src/diagnostics';

// Diagnostics spawns real processes, so each test gets a fresh state (the module
// is a singleton — one diagnostics command at a time).
describe('diagnostics module', () => {
  afterEach(() => {
    shutdownDiagnostics();
  });

  it('starts, shows running status, and stops a command', async () => {
    const started = diagStart('node -e "setInterval(()=>{}, 1000)"');
    expect(started.started).toBe(true);

    const status = diagStatus();
    expect(status.running).toBe(true);
    expect(status.command).toContain('setInterval');

    const stopped = diagStop();
    expect(stopped.stopped).toBe(true);
    expect(diagStatus().running).toBe(false);
  });

  it('reports exit code once the command finishes', async () => {
    diagStart('node -e "process.exit(3)"');
    // Wait for the process to actually exit.
    await Bun.sleep(300);
    const status = diagStatus();
    expect(status.running).toBe(false);
    expect(status.exit).toBe(3);
  });

  it('captures output into the tail', async () => {
    diagStart('node -e "console.log(\'hello-diag\')"');
    await Bun.sleep(300);
    const status = diagStatus();
    expect(status.tail).toContain('hello-diag');
    expect(status.exit).toBe(0);
  });

  it('diagStop with nothing running is a no-op', () => {
    expect(diagStop().stopped).toBe(false);
    expect(diagStatus().running).toBe(false);
  });

  it('starting replaces a running command and kills the old one', async () => {
    const oldHandle = diagStart('node -e "setInterval(()=>{}, 1000)"');
    expect(oldHandle.started).toBe(true);
    const second = diagStart('node -e "console.log(\'second\')"');
    expect(second.started).toBe(true);
    const status = diagStatus();
    expect(status.command).toContain('second');
    // old process is gone; status.command reflects the newest start
    shutdownDiagnostics();
  });

  it('bootDiagnostics ignores empty config and starts a real one', async () => {
    bootDiagnostics(undefined);
    expect(diagStatus().running).toBe(false);
    bootDiagnostics('node -e "setInterval(()=>{}, 1000)"');
    expect(diagStatus().running).toBe(true);
  });

  it('bootDiagnostics never throws on a bad command — keeps boot clean', async () => {
    expect(() => bootDiagnostics('')).not.toThrow();
    // A command that cannot spawn (bad binary) still must not throw synchronously.
    expect(() => bootDiagnostics('/nonexistent/binary')).not.toThrow();
    await Bun.sleep(50);
    shutdownDiagnostics();
  });
});

describe('defaultDiagnosticsCommand — auto-detection', () => {
  const tmp = `${Bun.env['TMPDIR'] ?? '/tmp'}/diag-default-${process.pid}-${Math.random().toString(36).slice(2)}`;
  let savedCwd: string;
  const { mkdirSync, rmSync, writeFileSync } = require('node:fs') as typeof import('node:fs');

  beforeEach(() => {
    savedCwd = process.cwd();
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    diagStop();
  });

  it('picks tsc --watch for a bun+ts project', async () => {
    writeFileSync('bun.lock', '');
    writeFileSync('package.json', '{}');
    writeFileSync('tsconfig.json', '{}');
    expect(await defaultDiagnosticsCommand(process.cwd())).toBe('bun run typecheck --watch');
  });

  it('falls back to bun test --watch without tsconfig', async () => {
    writeFileSync('bun.lock', '');
    writeFileSync('package.json', '{}');
    expect(await defaultDiagnosticsCommand(process.cwd())).toBe('bun test --watch');
  });

  it('returns undefined for an unknown project', async () => {
    expect(await defaultDiagnosticsCommand(process.cwd())).toBeUndefined();
  });
});