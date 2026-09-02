import { expect, test } from 'bun:test';
import { completePath, matchPaths, pathToken } from '../src/complete';

const paths = [
  'README.md',
  'src/app.ts',
  'src/session.ts',
  'src/ui/App.tsx',
  'src/ui/Panels.tsx',
  'test/session.test.ts',
  'vendor/src/legacy.ts',
];

test('a bare @ opens the token with an empty query', () => {
  expect(pathToken('@', 1)).toEqual({ start: 0, end: 1, query: '' });
});

test('the token is the text between @ and the cursor', () => {
  expect(pathToken('look at @src/ses', 16)).toEqual({ start: 8, end: 16, query: 'src/ses' });
});

test('@ mid-word is not a completion, so an email is left alone', () => {
  expect(pathToken('mail me@example.com', 19)).toBeUndefined();
  expect(pathToken('user@host', 9)).toBeUndefined();
});

test('a space ends the token', () => {
  expect(pathToken('@src/app.ts and then', 20)).toBeUndefined();
});

test('the cursor before the @ sees no token', () => {
  expect(pathToken('@src', 0)).toBeUndefined();
});

test('the nearest @ wins when there are two', () => {
  const token = pathToken('@first then @sec', 16);
  expect(token?.query).toBe('sec');
  expect(token?.start).toBe(12);
});

test('an empty query offers the shallowest paths first', () => {
  expect(matchPaths(paths, '', 3)).toEqual(['README.md', 'src/app.ts', 'src/session.ts']);
});

test('a directory prefix narrows to what is under it', () => {
  const hits = matchPaths(paths, 'src/ui/');
  expect(hits).toEqual(['src/ui/App.tsx', 'src/ui/Panels.tsx']);
});

test('prefix matches rank above substring matches', () => {
  const hits = matchPaths(paths, 'src/');
  expect(hits[0]).toBe('src/app.ts');
  // vendor/src/legacy.ts contains "src/" but is not under src/, so it comes last.
  expect(hits.at(-1)).toBe('vendor/src/legacy.ts');
  expect(hits.indexOf('src/session.ts')).toBeLessThan(hits.indexOf('vendor/src/legacy.ts'));
});

test('matching ignores case', () => {
  expect(matchPaths(paths, 'readme')).toEqual(['README.md']);
});

test('a query matching nothing yields nothing', () => {
  expect(matchPaths(paths, 'zzz')).toEqual([]);
});

test('the limit is honoured', () => {
  expect(matchPaths(paths, 's', 2)).toHaveLength(2);
});

test('completion replaces the token with a plain relative path', () => {
  const value = 'look at @src/ses';
  const token = pathToken(value, value.length)!;
  expect(completePath(value, token, 'src/session.ts')).toEqual({
    value: 'look at src/session.ts ',
    cursor: 23,
  });
});

test('completion keeps whatever followed the cursor', () => {
  const value = '@src/ses and explain';
  const token = pathToken(value, 8)!;
  const { value: next } = completePath(value, token, 'src/session.ts');
  expect(next).toBe('src/session.ts  and explain');
});

test('the inserted path carries no @', () => {
  const token = pathToken('@READ', 5)!;
  expect(completePath('@READ', token, 'README.md').value).not.toContain('@');
});
