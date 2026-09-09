import { expect, test } from 'bun:test';
import { unknownToolSetNames } from '../src/config';

test('unknownToolSetNames flags typos and ignores valid ones', () => {
  expect(unknownToolSetNames(['edit-plus', 'gti', 'net', 'extra'])).toEqual(['gti']);
  expect(unknownToolSetNames(['core', 'git'])).toEqual([]);
  expect(unknownToolSetNames(undefined)).toEqual([]);
  expect(unknownToolSetNames([])).toEqual([]);
  expect(unknownToolSetNames(null)).toEqual([]);
});
