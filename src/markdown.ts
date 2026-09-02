export type Span = { text: string; bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean; link?: boolean };

export type Block =
  | { kind: 'heading'; level: number; spans: Span[] }
  | { kind: 'paragraph'; spans: Span[] }
  | { kind: 'bullet'; indent: number; marker: string; spans: Span[] }
  | { kind: 'quote'; spans: Span[] }
  | { kind: 'code'; language: string; lines: string[] }
  | { kind: 'rule' }
  | { kind: 'blank' };

const INLINE =
  /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|(?<![A-Za-z0-9_])_([^\s_][\s\S]*?)_(?![A-Za-z0-9_])|\*([^\s*][\s\S]*?)\*|\[([^\]]+)\]\(([^)]+)\)/;

/**
 * Inline markdown to styled spans.
 *
 * Code spans are matched first and their contents are never re-scanned, so
 * `` `**not bold**` `` stays literal — the mistake a naive replace-based
 * renderer makes on every code sample an agent prints. Underscore emphasis is
 * also required to sit at a word boundary, so `snake_case_name` survives.
 */
export function parseInline(input: string): Span[] {
  const spans: Span[] = [];
  let rest = input;

  while (rest.length > 0) {
    const m = INLINE.exec(rest);
    if (!m || m.index === undefined) {
      spans.push({ text: rest });
      break;
    }

    if (m.index > 0) spans.push({ text: rest.slice(0, m.index) });

    if (m[2] !== undefined) spans.push({ text: m[2].trim(), code: true });
    else if (m[3] !== undefined) spans.push(...parseInline(m[3]).map((s) => ({ ...s, bold: true })));
    else if (m[4] !== undefined) spans.push(...parseInline(m[4]).map((s) => ({ ...s, bold: true })));
    else if (m[5] !== undefined) spans.push(...parseInline(m[5]).map((s) => ({ ...s, strike: true })));
    else if (m[6] !== undefined) spans.push(...parseInline(m[6]).map((s) => ({ ...s, italic: true })));
    else if (m[7] !== undefined) spans.push(...parseInline(m[7]).map((s) => ({ ...s, italic: true })));
    else if (m[8] !== undefined) spans.push({ text: m[8], link: true });

    rest = rest.slice(m.index + m[0].length);
  }

  return spans.filter((s) => s.text.length > 0);
}

const FENCE = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/**
 * Line-based markdown parser covering what an agent actually emits: headings,
 * fences, lists, quotes, rules, and inline styling. Not CommonMark — no nested
 * blocks, tables, or reference links, none of which appear in agent replies.
 */
export function parseMarkdown(input: string): Block[] {
  const blocks: Block[] = [];
  const lines = input.replace(/\r\n/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fence = FENCE.exec(line);
    if (fence) {
      const closer = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${closer[0]}{${closer.length},}\\s*$`).test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      blocks.push({ kind: 'code', language: fence[2] ?? '', lines: body });
      continue;
    }

    if (line.trim().length === 0) {
      if (blocks.at(-1)?.kind !== 'blank') blocks.push({ kind: 'blank' });
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, spans: parseInline(heading[2]!) });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      blocks.push({
        kind: 'bullet',
        indent: Math.floor(bullet[1]!.length / 2),
        marker: /\d/.test(bullet[2]!) ? bullet[2]! : '-',
        spans: parseInline(bullet[3]!),
      });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      blocks.push({ kind: 'quote', spans: parseInline(quote[1]!) });
      continue;
    }

    // Consecutive plain lines join into one paragraph so wrapping is the terminal's job.
    const previous = blocks.at(-1);
    if (previous?.kind === 'paragraph') {
      previous.spans.push({ text: ' ' }, ...parseInline(line.trim()));
    } else {
      blocks.push({ kind: 'paragraph', spans: parseInline(line.trim()) });
    }
  }

  while (blocks.at(-1)?.kind === 'blank') blocks.pop();
  return blocks;
}

/** Plain text with the markup removed, for widths and non-styled surfaces. */
export function toPlainText(blocks: Block[]): string {
  return blocks
    .map((b) => {
      switch (b.kind) {
        case 'code':
          return b.lines.join('\n');
        case 'rule':
          return '---';
        case 'blank':
          return '';
        case 'bullet':
          return `${'  '.repeat(b.indent)}${b.marker} ${b.spans.map((s) => s.text).join('')}`;
        case 'heading':
          return `${'#'.repeat(b.level)} ${b.spans.map((s) => s.text).join('')}`;
        default:
          return b.spans.map((s) => s.text).join('');
      }
    })
    .join('\n');
}
