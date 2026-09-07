/**
 * The shared visual language for the whole UI.
 *
 * Every glyph, accent colour, and spacing constant lives here once, so a panel,
 * the transcript, and the status bar agree with each other instead of each having
 * grown its own dialect. The palette is deliberately narrow: one accent per
 * *kind* of thing, reused everywhere that kind appears.
 *
 *   cyan    - the user and interactive affordances (you, keys you can press)
 *   green   - success, additions, the assistant's done state
 *   magenta - tools and delegated work (the machine acting)
 *   yellow  - caution, working state, decisions that need you
 *   red     - errors, removals, denials
 *   gray    - the quiet layer: hints, metadata, separators
 */

export const accent = {
  user: 'cyan',
  ok: 'green',
  tool: 'magenta',
  warn: 'yellow',
  err: 'red',
  mute: 'gray',
  info: 'blue',
} as const;

/** Glyphs that read in any monospace font; no emoji, no nerd-font dependency. */
export const glyph = {
  user: '>',
  assistant: '●',
  toolOk: '●',
  toolErr: '✕',
  ok: '✓',
  err: '✕',
  warn: '▲',
  info: '·',
  bullet: '•',
  dash: '─',
  sep: '│',
  result: '→',
  pending: '○',
  progress: '◆',
  blocked: '✕',
  spinWorking: '⠋',
  meterFull: '█',
  meterEmpty: '░',
  queued: '▸',
  fold: '…',
} as const;

/**
 * A thin horizontal rule, for separating a panel header from its body without a
 * full second border. Width is clamped so a narrow terminal still gets a line.
 */
export const rule = (width: number) => glyph.dash.repeat(Math.max(4, width));

/** A tiny inline context meter, e.g. `███░░░░░░░ 34%`. Fixed cell count so the bar never shifts layout. */
export function meter(ratio: number, cells = 10): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * cells);
  return glyph.meterFull.repeat(filled) + glyph.meterEmpty.repeat(Math.max(0, cells - filled));
}

/** Shorten a path or label to `n` columns, keeping the tail (the identifying part). */
export const clipTail = (s: string, n = 68) => (s.length > n ? `…${s.slice(-(n - 1))}` : s);
