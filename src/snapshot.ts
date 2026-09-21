import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';

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

/** One file as it was before the turn that changed it. `before === undefined` means it did not exist. */
export type PreImage = {
  /** Workspace-relative, using forward slashes, so a restore is portable across platforms. */
  path: string;
  before: string | undefined;
};

export type TurnSnapshot = {
  /** Monotonic turn number, so the UI can name what is being undone. */
  turn: number;
  at: string;
  /** The user prompt that opened the turn, for a menu that lists them. */
  prompt: string;
  /** Files this turn changed, with their content from before it started. */
  files: PreImage[];
  /** The conversation length when the turn began, so undo can trim it back. */
  messageCount: number;
};

/** Claude Code keeps 100; beyond that the memory is worth more than the recall. */
export const MAX_SNAPSHOTS = 100;

/** A single file larger than this is not snapshotted; a 40 MB binary is not an edit. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * The workspace-relative, slash-normalised form of a path, or undefined if it is
 * outside the workspace.
 *
 * Outside is refused rather than clamped: a path that escapes the workspace is not
 * something this repository can undo, and recording it would imply an undo that
 * cannot happen. Paths are normalised to forward slashes because a snapshot written
 * on Windows may be read on a machine where a backslash is a filename character.
 */
export function relPath(cwd: string, abs: string): string | undefined {
  const root = resolve(cwd);
  const target = resolve(abs);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`)) return undefined;
  return rel.split(sep).join('/');
}

/**
 * The absolute path a tool call will write to, when there is exactly one.
 *
 * Deliberately a small, explicit map rather than a guess. `multi_edit` and the line
 * editors each take a single `path`; `move_file` takes `from` and `to` and both are
 * recorded; `delete_file` takes a `path`. `apply_patch` carries its paths inside the
 * patch text, and `bash` carries none — both are reported as uncovered rather than
 * silently not snapshotted.
 */
export function touchedPaths(toolName: string, input: unknown): { paths: string[]; covered: boolean } {
  const o = (input ?? {}) as Record<string, unknown>;
  const one = (key: string) => (typeof o[key] === 'string' ? [o[key] as string] : []);

  switch (toolName) {
    case 'write_file':
    case 'edit_file':
    case 'multi_edit':
    case 'delete_file':
    case 'insert_lines':
    case 'delete_lines':
    case 'replace_lines':
    case 'append_file':
    case 'prepend_file':
      return { paths: one('path'), covered: true };
    case 'move_file':
      return { paths: [...one('from'), ...one('to')], covered: true };
    case 'apply_patch': {
      const patch = typeof o['patch'] === 'string' ? (o['patch'] as string) : '';
      const paths = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]!.trim());
      const moves = [...patch.matchAll(/^\*\*\* Move to: (.+)$/gm)].map((m) => m[1]!.trim());
      return { paths: [...paths, ...moves], covered: true };
    }
    case 'bash':
      // Arbitrary code: an untouched-looking `node -e` can rewrite the tree.
      return { paths: [], covered: false };
    default:
      return { paths: [], covered: true };
  }
}

/**
 * Records pre-images for the files a turn changes, and restores them on undo.
 *
 * One instance per session. Holds at most MAX_SNAPSHOTS turns; the oldest falls off
 * the front, because the turn someone wants back is almost always the last one.
 */
export class Snapshots {
  private readonly turns: TurnSnapshot[] = [];
  private current: { turn: number; at: string; prompt: string; files: Map<string, string | undefined>; messageCount: number } | null =
    null;
  private next = 1;
  private readonly cwd: string;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
  }

  /** Opens a turn. Called once per user prompt, before the model runs. */
  begin(prompt: string, messageCount: number): void {
    this.current = { turn: this.next++, at: new Date().toISOString(), prompt, files: new Map(), messageCount };
  }

  /**
   * Records a file's content before a tool changes it, on the first write of the turn.
   *
   * Idempotent per path per turn: the second `write_file` to the same path in one turn
   * must not replace the pre-image with the intermediate content the first write left,
   * because undo restores the turn's starting state, not the midpoint.
   *
   * Read failures are swallowed. A snapshot is a convenience; a tool call that fails
   * because the snapshot layer could not read an unrelated path would be worse than no
   * undo at all.
   */
  async capture(absPath: string): Promise<void> {
    if (!this.current) return;
    const rel = relPath(this.cwd, absPath);
    if (rel === undefined) return;
    if (this.current.files.has(rel)) return;

    try {
      const file = Bun.file(absPath);
      const exists = await file.exists();
      if (!exists) {
        this.current.files.set(rel, undefined);
        return;
      }
      if (file.size > MAX_FILE_BYTES) return;
      this.current.files.set(rel, await file.text());
    } catch {
      return;
    }
  }

  /** Records any path a tool call is about to touch. Returns whether the tool is covered at all. */
  async captureFor(toolName: string, input: unknown): Promise<{ covered: boolean; paths: string[] }> {
    const { paths, covered } = touchedPaths(toolName, input);
    for (const p of paths) await this.capture(resolve(this.cwd, p));
    return { paths, covered };
  }

  /**
   * Closes the turn, keeping it only if it changed something.
   *
   * A turn that read and answered without writing is not worth a slot, and keeping it
   * would make `/undo` step past a turn that has nothing to undo — which reads as the
   * command being broken.
   */
  commit(): TurnSnapshot | undefined {
    const cur = this.current;
    this.current = null;
    if (!cur || cur.files.size === 0) return undefined;

    const snap: TurnSnapshot = {
      turn: cur.turn,
      at: cur.at,
      prompt: cur.prompt,
      files: [...cur.files].map(([path, before]) => ({ path, before })),
      messageCount: cur.messageCount,
    };
    this.turns.push(snap);
    while (this.turns.length > MAX_SNAPSHOTS) this.turns.shift();
    return snap;
  }

  /** Discards the open turn without recording it, for an aborted or failed turn. */
  discard(): void {
    this.current = null;
  }

  /** The turns that can be undone, newest first. */
  list(): readonly TurnSnapshot[] {
    return [...this.turns].reverse();
  }

  /** Whether there is an open turn collecting pre-images right now. */
  get open(): boolean {
    return this.current !== null;
  }

  /**
   * Removes the newest turn and returns what it holds, without restoring.
   *
   * Separated from restoring so the caller can decide *what* to bring back —
   * files, conversation, or both — which is the split Claude Code's rewind menu
   * exposes and the reason one control surface is worth more than three commands.
   */
  pop(): TurnSnapshot | undefined {
    return this.turns.pop();
  }

  /** Puts a turn back, for a `/redo` that follows an `/undo`. */
  push(snap: TurnSnapshot): void {
    this.turns.push(snap);
  }

  get size(): number {
    return this.turns.length;
  }

  cwdOf(): string {
    return this.cwd;
  }

  clear(): void {
    this.turns.length = 0;
    this.current = null;
  }
}

/** Writes a pre-image back to disk, recreating a deleted file or removing one that was created. */
export async function restore(snap: TurnSnapshot, cwd = process.cwd()): Promise<{ restored: string[]; removed: string[] }> {
  const restored: string[] = [];
  const removed: string[] = [];

  for (const file of snap.files) {
    const abs = join(cwd, file.path);
    if (file.before === undefined) {
      // The file did not exist before the turn, so undoing its creation is removing it.
      const f = Bun.file(abs);
      if (await f.exists()) {
        await f.delete();
        removed.push(file.path);
      }
      continue;
    }
    await Bun.write(abs, file.before);
    restored.push(file.path);
  }

  return { restored, removed };
}

/** A short, stable label for a snapshot, for a menu that lists several. */
export function labelOf(snap: TurnSnapshot): string {
  const first = snap.prompt.trim().split('\n')[0] ?? '';
  const clipped = first.length > 50 ? `${first.slice(0, 50)}...` : first || '(no prompt)';
  return `turn ${snap.turn}: ${clipped}`;
}

/** A content hash, used to tell whether a file still matches what the snapshot holds. */
export function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/* -------------------------------------------------------------------------- */
/* Fork's SnapshotStack — kept for the fork's undo/redo tests and API surface. */
/* -------------------------------------------------------------------------- */

export type FileState = { existed: boolean; content: string | null };

/** The fork's undo stack entry shape: before/after message lengths + file maps. */
type StackEntry = {
  beforeLen: number;
  afterLen: number;
  beforeFiles: Map<string, FileState>;
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
  private readonly history: StackEntry[] = [];
  private readonly future: StackEntry[] = [];

  push(entry: StackEntry): void {
    this.history.push(entry);
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.future.length = 0;
  }

  canUndo(): boolean { return this.history.length > 0; }
  canRedo(): boolean { return this.future.length > 0; }

  /** The most recent snapshot without consuming it — lets a caller diff the last turn. */
  peek(): StackEntry | undefined {
    return this.history.at(-1);
  }

  popForUndo(): StackEntry | undefined {
    const e = this.history.pop();
    if (e) this.future.push(e);
    return e;
  }

  popForRedo(): StackEntry | undefined {
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