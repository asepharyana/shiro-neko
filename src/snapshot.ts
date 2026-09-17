import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';

/**
 * Pre-images of files a turn is about to change, so a turn can be walked back.
 *
 * The design follows the one thing every comparable CLI agrees on and the one thing
 * they all get wrong in the same way. Agreement: a snapshot is taken *before* the
 * turn runs, because after it runs the original content is gone. The shared flaw: a
 * snapshot only covers the tools that write through a known interface — Claude Code
 * tracks Write/Edit/NotebookEdit and explicitly not `bash` — so the undo is partial
 * and the user has to know which half they are in.
 *
 * Two decisions fall out of taking that seriously.
 *
 * 1. Capture lazily, per file, not by walking the tree. A session turn may touch
 *    three files out of fifty thousand; a full-tree copy per prompt is a tarball of
 *    the repository the user did not ask for and cannot afford. Instead the first
 *    write to a path records its pre-image, and a later write to the same path in
 *    the same turn does not overwrite it — the pre-image is the state before the
 *    *turn*, which is what an undo restores.
 *
 * 2. Record what is *not* covered rather than implying it is. A `bash` command that
 *    rewrites a file, a `git checkout`, a build artifact — none of these pass through
 *    a path argument the way `write_file` does, so none are captured. The tool
 *    reports which paths it restored and the caller is told the rest is unknown,
 *    which is the same honesty `bash` already owes an interrupted command.
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
