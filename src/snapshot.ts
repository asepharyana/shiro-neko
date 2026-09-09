/**
 * Per-turn file snapshots for /undo and /redo.
 *
 * Bash is intentionally not snapshotted: a shell command can do anything
 * (network, database, chmod, rm -rf) and there is no way to know what to
 * restore. The docs and the undo notice say so plainly.
 *
 * File tools call `recordBeforeWrite(abs)` before their first write to a path
 * in the current turn. Session drains the map at turn boundaries into its
 * history stack (cap 100) and owns undo/redo.
 */

export type FileState = { existed: boolean; content: string | null };

export type TurnSnapshot = {
  /** Messages length before the turn's user message was pushed. */
  beforeLen: number;
  /** Messages length after the turn completed (including tool results). */
  afterLen: number;
  /** File state before the turn, keyed by absolute path. Only files the turn touched. */
  beforeFiles: Map<string, FileState>;
  /** File state after the turn, for redo. */
  afterFiles: Map<string, FileState>;
};

const MAX_HISTORY = 100;

let hook: ((abs: string) => Promise<void> | void) | undefined;

export function onBeforeWrite(fn: ((abs: string) => Promise<void> | void) | undefined): void {
  hook = fn;
}

export async function recordBeforeWrite(abs: string): Promise<void> {
  const fn = hook;
  if (fn) await fn(abs);
}

export class SnapshotStack {
  private readonly history: TurnSnapshot[] = [];
  private readonly future: TurnSnapshot[] = [];

  push(entry: TurnSnapshot): void {
    this.history.push(entry);
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.future.length = 0;
  }

  canUndo(): boolean { return this.history.length > 0; }
  canRedo(): boolean { return this.future.length > 0; }

  popForUndo(): TurnSnapshot | undefined {
    const e = this.history.pop();
    if (e) this.future.push(e);
    return e;
  }

  popForRedo(): TurnSnapshot | undefined {
    const e = this.future.pop();
    if (e) this.history.push(e);
    return e;
  }

  clear(): void {
    this.history.length = 0;
    this.future.length = 0;
  }

  depth(): { undo: number; redo: number } {
    return { undo: this.history.length, redo: this.future.length };
  }
}
