/**
 * Structured diff review for /diff review.
 *
 * Turns a unified diff into per-hunk entries, each with the file, the line
 * range the hunk touches, and the hunk body. Pure on purpose: parse here,
 * render anywhere, test without a terminal.
 */

export type DiffHunk = {
  /** File the hunk belongs to, relative to the workspace root. */
  file: string;
  /** Hunk header, e.g. "@@ -1,5 +1,6 @@". */
  header: string;
  /** First line of the old-file range; 1-based. */
  oldStart: number;
  /** First line of the new-file range; 1-based. */
  newStart: number;
  /** The hunk body including + / - / context lines. */
  body: string;
};

/**
 * Splits a unified diff into its file sections, then each section into hunks.
 *
 * A file section starts at `diff --git a/x b/y`, and the hunk header
 * `@@ -a,b +c,d @@` starts each hunk. `---`/`+++` lines inside a hunk body
 * are just content lines (they carry a leading space or +/-), so they are
 * never mistaken for a new section.
 */
export function parseDiffHunks(diff: string): DiffHunk[] {
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  const hunks: DiffHunk[] = [];
  let currentFile = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fileHeader = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (fileHeader) {
      currentFile = fileHeader[2]!;
      continue;
    }

    const hunkHeader = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunkHeader) {
      const body: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!;
        if (/^diff --git /.test(next) || /^@@ /.test(next)) break;
        body.push(next);
      }
      hunks.push({
        file: currentFile,
        header: line,
        oldStart: Number(hunkHeader[1]),
        newStart: Number(hunkHeader[2]),
        body: body.join('\n'),
      });
      continue;
    }
  }
  return hunks;
}

/**
 * Renders a hunk for human review, with the file:line anchor the reader needs
 * to find it in their editor.
 */
export function renderHunk(h: DiffHunk): string {
  return [`${h.file}:${h.newStart}  ${h.header}`, h.body].filter(Boolean).join('\n');
}

/**
 * The /diff review output: every hunk of the last turn's changes, one block
 * per hunk, each headed by its file:line anchor and hunk header.
 */
export function renderDiffReview(diff: string): string {
  const hunks = parseDiffHunks(diff);
  if (hunks.length === 0) return 'no hunks to review';
  return ['diff review:', ...hunks.map(renderHunk)].join('\n\n');
}