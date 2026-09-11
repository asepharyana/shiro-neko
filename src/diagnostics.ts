import { join } from 'node:path';

/**
 * Live diagnostics: a background check command whose output is shown in the UI
 * but never reaches the model's context.
 *
 * The difference from `startBackground` in tools.ts is deliberate. A background
 * bash command is a tool result the model owns; its tail feeds the transcript
 * through the bash listener. Diagnostics are the opposite: a check the *user*
 * wants to watch (tsc in watch mode, a test watcher) while the model works. Its
 * output would be pure noise in the prompt — a file-watcher re-emits the whole
 * tree on every save — so it is buffered here, separate from the bash journal,
 * and only the UI reads it.
 *
 * One at a time: a diagnostics panel is a single line of state, and running two
 * watchers (e.g. tsc + a test watcher) is what the model's own tools are for.
 */

export type DiagState = {
  command: string;
  proc: Bun.Subprocess;
  /** Append-only, capped. Tail is what the panel shows. */
  tail: string;
  exit: number | null;
  startedAt: number;
};

let current: DiagState | undefined;

const MAX_DIAG = 20_000;
const cap = (s: string) => (s.length <= MAX_DIAG ? s : s.slice(-MAX_DIAG));

/** Start a diagnostics command, replacing any running one (old one is killed). */
export function diagStart(command: string): { started: boolean; replaced?: boolean; command: string } {
  diagStop();
  const shell = process.platform === 'win32' ? ['cmd', '/c', command] : ['bash', '-lc', command];
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(shell, { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  } catch (e) {
    throw new Error(`could not start diagnostics: ${e instanceof Error ? e.message : String(e)}`);
  }
  current = { command, proc, tail: '', exit: null, startedAt: Date.now() };
  void proc.exited.then((code) => {
    if (current?.proc === proc) current!.exit = code;
  });
  const pump = async (stream: ReadableStream<Uint8Array> | undefined) => {
    if (!stream) return;
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      if (!text) continue;
      if (current?.proc === proc) current!.tail = cap(current!.tail + text);
    }
  };
  void pump(proc.stdout as ReadableStream<Uint8Array>);
  void pump(proc.stderr as ReadableStream<Uint8Array>);
  return { started: true, command };
}

/** Kill the running diagnostics command, if any. */
export function diagStop(): { stopped: boolean; command?: string } {
  const d = current;
  if (!d) return { stopped: false };
  current = undefined;
  try {
    d.proc.kill();
  } catch {
    // already gone
  }
  return { stopped: true, command: d.command };
}

/** Snapshot for the UI panel. `exit` stays null while running. */
export function diagStatus(): { running: boolean; command?: string; exit: number | null; tail: string; startedAt: number } {
  if (!current) return { running: false, exit: null, tail: '', startedAt: 0 };
  return {
    running: current!.exit === null,
    command: current!.command,
    exit: current!.exit,
    tail: current!.tail,
    startedAt: current!.startedAt,
  };
}

/**
 * Warm the diagnostics from config at boot, but never crash boot on a bad
 * command string — the user can fix it with /diagnostics stop + start.
 */
export function bootDiagnostics(configDiagnostics: string | undefined): void {
  if (!configDiagnostics?.trim()) return;
  try {
    diagStart(configDiagnostics.trim());
  } catch {
    // keep boot clean; /diagnostics start will report the real error
  }
}

/** A default check command, mirroring run_checks' detection but for watch-style loops. */
export async function defaultDiagnosticsCommand(cwd: string): Promise<string | undefined> {
  const has = async (p: string) => Bun.file(join(cwd, p)).exists();
  if ((await has('bun.lock')) || (await has('package.json'))) {
    if (await has('tsconfig.json')) return 'bun run typecheck --watch';
    return 'bun test --watch';
  }
  if (await has('Cargo.toml')) return 'cargo watch -x check';
  if (await has('go.mod')) return 'go build ./...';
  return undefined;
}

/** Kill any running diagnostics on shutdown; best-effort, never throws. */
export function shutdownDiagnostics(): void {
  try {
    diagStop();
  } catch {
    // nothing to reap
  }
}