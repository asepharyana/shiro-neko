import { join } from 'node:path';

/**
 * A single file change captured so it can be undone.
 *
 * `before` is the full prior contents and `existed` records whether the file was
 * present. Restoring a mutation therefore either writes the old bytes back or
 * deletes the file, whichever undoes the change.
 */
export type FileMutation = {
  abs: string;
  before: string | undefined;
  existed: boolean;
};

/** Prior contents of every file a tool is about to touch, or undefined when new. */
export async function captureFiles(absPaths: string[]): Promise<FileMutation[]> {
  const out: FileMutation[] = [];
  for (const abs of absPaths) {
    const file = Bun.file(abs);
    const existed = await file.exists();
    out.push({ abs, existed, before: existed ? await file.text() : undefined });
  }
  return out;
}

/** Restores one mutation. Deletes the file when it did not exist before. */
export async function restoreFile(m: FileMutation): Promise<void> {
  if (m.existed && m.before !== undefined) {
    await Bun.write(m.abs, m.before);
  } else {
    // Either it never existed (delete the created file) or we have no bytes to
    // restore (treat as delete — the safest interpretation of an unknown state).
    if (await Bun.file(m.abs).exists()) await Bun.file(m.abs).delete();
  }
}

/** Restores a list of mutations, newest first so later writes undo first. */
export async function restoreFiles(mutations: FileMutation[]): Promise<string[]> {
  const restored: string[] = [];
  // Newest-last ordering in the log means the last write is popped first, which
  // restores the file to its true prior state when a file was written twice.
  for (const m of [...mutations].reverse()) {
    try {
      await restoreFile(m);
      restored.push(m.abs);
    } catch {
      // A file that no longer exists or cannot be written is left as-is rather
      // than failing the whole undo; the log entry is skipped.
    }
  }
  return restored;
}

export const undoFileDir = (cwd: string) => join(cwd, '.shiro');
