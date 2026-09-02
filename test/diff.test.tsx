import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import { collapseContext, Diff, diffLines } from '../src/ui/Diff';

const kinds = (before: string, after: string) => diffLines(before, after).map((l) => `${l.kind[0]}:${l.text}`);

test('identical text is all context', () => {
  expect(kinds('a\nb', 'a\nb')).toEqual(['c:a', 'c:b']);
});

test('a changed line shows as one remove and one add', () => {
  expect(kinds('const a = 1;', 'const a = 2;')).toEqual(['r:const a = 1;', 'a:const a = 2;']);
});

test('an inserted line keeps the surrounding lines as context', () => {
  expect(kinds('a\nc', 'a\nb\nc')).toEqual(['c:a', 'a:b', 'c:c']);
});

test('a deleted line is reported as a removal', () => {
  expect(kinds('a\nb\nc', 'a\nc')).toEqual(['c:a', 'r:b', 'c:c']);
});

test('writing into an empty file is all additions', () => {
  expect(kinds('', 'x\ny')).toEqual(['r:', 'a:x', 'a:y']);
});

test('long unchanged runs collapse into a gap', () => {
  const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].join('\n');
  const after = before.replace('5', 'five');
  const rows = collapseContext(diffLines(before, after), 1);
  expect(rows.some((r) => r.kind === 'gap')).toBe(true);
  expect(rows.filter((r) => r.kind === 'add')).toHaveLength(1);
  expect(rows.filter((r) => r.kind === 'remove')).toHaveLength(1);
});

test('a diff with no context to hide produces no gap', () => {
  const rows = collapseContext(diffLines('a', 'b'), 2);
  expect(rows.some((r) => r.kind === 'gap')).toBe(false);
});

test('the rendered diff marks additions and removals and counts them', () => {
  const app = render(<Diff before={'keep\nold'} after={'keep\nnew'} path="src/app.ts" />);
  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('src/app.ts');
  expect(frame).toContain('+1');
  expect(frame).toContain('-1');
  expect(frame).toContain(' - old');
  expect(frame).toContain(' + new');
  app.unmount();
});

test('a very large diff is truncated with a notice', () => {
  const before = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const after = Array.from({ length: 200 }, (_, i) => `changed ${i}`).join('\n');
  const app = render(<Diff before={before} after={after} />);
  expect(app.lastFrame()).toContain('more diff lines');
  app.unmount();
});
