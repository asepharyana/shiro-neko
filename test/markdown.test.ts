import { expect, test } from 'bun:test';
import { parseInline, parseMarkdown, toPlainText } from '../src/markdown';

const kinds = (input: string) => parseMarkdown(input).map((b) => b.kind);

test('plain text is one paragraph', () => {
  expect(parseMarkdown('hello world')).toEqual([{ kind: 'paragraph', spans: [{ text: 'hello world' }] }]);
});

test('headings carry their level', () => {
  const blocks = parseMarkdown('# One\n## Two\n###### Six');
  expect(blocks.map((b) => (b.kind === 'heading' ? b.level : 0))).toEqual([1, 2, 6]);
});

test('seven hashes is not a heading', () => {
  expect(kinds('####### too many')).toEqual(['paragraph']);
});

test('a fenced block keeps its language and lines verbatim', () => {
  const blocks = parseMarkdown('```ts\nconst a = 1;\n\nconst b = 2;\n```');
  expect(blocks).toHaveLength(1);
  const block = blocks[0]!;
  if (block.kind !== 'code') throw new Error('expected a code block');
  expect(block.language).toBe('ts');
  expect(block.lines).toEqual(['const a = 1;', '', 'const b = 2;']);
});

test('markup inside a fence is never interpreted', () => {
  const blocks = parseMarkdown('```\n# not a heading\n- not a bullet\n**not bold**\n```');
  const block = blocks[0]!;
  if (block.kind !== 'code') throw new Error('expected a code block');
  expect(block.lines).toEqual(['# not a heading', '- not a bullet', '**not bold**']);
});

test('an unclosed fence still yields a code block, for partial streams', () => {
  const blocks = parseMarkdown('```js\nconst partial = ');
  const block = blocks[0]!;
  if (block.kind !== 'code') throw new Error('expected a code block');
  expect(block.lines).toEqual(['const partial = ']);
});

test('tilde fences work too', () => {
  expect(kinds('~~~\ncode\n~~~')).toEqual(['code']);
});

test('bullets keep their indent and marker', () => {
  const blocks = parseMarkdown('- one\n  - nested\n* star\n1. first\n2) second');
  const bullets = blocks.filter((b) => b.kind === 'bullet');
  expect(bullets).toHaveLength(5);
  expect(bullets.map((b) => (b.kind === 'bullet' ? b.indent : -1))).toEqual([0, 1, 0, 0, 0]);
  expect(bullets.map((b) => (b.kind === 'bullet' ? b.marker : ''))).toEqual(['-', '-', '-', '1.', '2)']);
});

test('quotes and rules are recognised', () => {
  expect(kinds('> quoted')).toEqual(['quote']);
  expect(kinds('---')).toEqual(['rule']);
  expect(kinds('***')).toEqual(['rule']);
  expect(kinds('___')).toEqual(['rule']);
});

test('two hyphens are not a rule', () => {
  expect(kinds('--')).toEqual(['paragraph']);
});

test('consecutive lines join into one paragraph', () => {
  const blocks = parseMarkdown('first line\nsecond line');
  expect(blocks).toHaveLength(1);
  expect(toPlainText(blocks)).toBe('first line second line');
});

test('a blank line separates paragraphs and collapses runs', () => {
  expect(kinds('one\n\n\n\ntwo')).toEqual(['paragraph', 'blank', 'paragraph']);
});

test('trailing blanks are trimmed', () => {
  expect(kinds('text\n\n\n')).toEqual(['paragraph']);
});

test('bold, italic, strike, and code spans are marked', () => {
  expect(parseInline('**bold**')).toEqual([{ text: 'bold', bold: true }]);
  expect(parseInline('*italic*')).toEqual([{ text: 'italic', italic: true }]);
  expect(parseInline('__also bold__')).toEqual([{ text: 'also bold', bold: true }]);
  expect(parseInline('~~gone~~')).toEqual([{ text: 'gone', strike: true }]);
  expect(parseInline('`code`')).toEqual([{ text: 'code', code: true }]);
});

test('a code span is never re-scanned for markup', () => {
  expect(parseInline('`**not bold**`')).toEqual([{ text: '**not bold**', code: true }]);
});

test('bold wins over italic on the same run', () => {
  expect(parseInline('**both**')).toEqual([{ text: 'both', bold: true }]);
});

test('nesting inside bold is preserved', () => {
  expect(parseInline('**bold `code`**')).toEqual([
    { text: 'bold ', bold: true },
    { text: 'code', code: true, bold: true },
  ]);
});

test('a link keeps its text and is flagged', () => {
  expect(parseInline('see [the docs](https://example.com)')).toEqual([
    { text: 'see ' },
    { text: 'the docs', link: true },
  ]);
});

test('surrounding text is kept around inline markup', () => {
  expect(parseInline('before **mid** after')).toEqual([
    { text: 'before ' },
    { text: 'mid', bold: true },
    { text: ' after' },
  ]);
});

test('an underscore inside a word is not italic', () => {
  expect(parseInline('snake_case_name')).toEqual([{ text: 'snake_case_name' }]);
});

test('unmatched markers stay literal', () => {
  expect(parseInline('a ** dangling')).toEqual([{ text: 'a ** dangling' }]);
  expect(parseInline('unclosed `code')).toEqual([{ text: 'unclosed `code' }]);
});

test('inline markup inside a heading is parsed', () => {
  const blocks = parseMarkdown('# A `code` heading');
  const block = blocks[0]!;
  if (block.kind !== 'heading') throw new Error('expected a heading');
  expect(block.spans.some((s) => s.code)).toBe(true);
});

test('toPlainText round-trips the structure without markup', () => {
  const text = '# Title\n\nSome **bold** text.\n\n- item one\n- item two\n\n```ts\ncode();\n```';
  const plain = toPlainText(parseMarkdown(text));
  expect(plain).toContain('# Title');
  expect(plain).toContain('Some bold text.');
  expect(plain).toContain('- item one');
  expect(plain).toContain('code();');
  expect(plain).not.toContain('**');
});

test('windows line endings are handled', () => {
  expect(kinds('# One\r\n\r\ntext')).toEqual(['heading', 'blank', 'paragraph']);
});

test('an empty document yields no blocks', () => {
  expect(parseMarkdown('')).toEqual([]);
  expect(parseMarkdown('   \n\n  ')).toEqual([]);
});

test('a realistic agent reply parses into the expected shape', () => {
  const reply = [
    'Fixed the off-by-one in `paginate()`.',
    '',
    '## What changed',
    '',
    '- `src/users.ts:42` now uses `<=` instead of `<`',
    '- added a boundary test',
    '',
    '```ts',
    'if (offset <= total) next();',
    '```',
    '',
    '> Note: the old behaviour dropped the last row.',
  ].join('\n');

  expect(kinds(reply)).toEqual([
    'paragraph',
    'blank',
    'heading',
    'blank',
    'bullet',
    'bullet',
    'blank',
    'code',
    'blank',
    'quote',
  ]);
});
