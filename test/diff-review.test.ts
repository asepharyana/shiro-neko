import { describe, expect, it } from 'bun:test';
import { parseDiffHunks, renderDiffReview } from '../src/diff-review';

const SAMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
@@ -1,5 +1,6 @@
 import { a } from './a';
+import { b } from './b';
 const x = 1;
 const y = 2;
 const z = 3;
@@ -10,3 +11,2 @@
 function foo() {
-  return 0;
 }
diff --git a/src/bar.ts b/src/bar.ts
@@ -1,4 +1,1 @@
-a
-b
-c
+d
`;

describe('parseDiffHunks', () => {
  it('finds hunk headers across files', () => {
    const hunks = parseDiffHunks(SAMPLE_DIFF);
    expect(hunks.length).toBe(3);
    expect(hunks[0]!.file).toBe('src/foo.ts');
    expect(hunks[0]!.oldStart).toBe(1);
    expect(hunks[0]!.newStart).toBe(1);
    expect(hunks[1]!.file).toBe('src/foo.ts');
    expect(hunks[1]!.oldStart).toBe(10);
    expect(hunks[1]!.newStart).toBe(11);
    expect(hunks[2]!.file).toBe('src/bar.ts');
    expect(hunks[2]!.oldStart).toBe(1);
    expect(hunks[2]!.newStart).toBe(1);
  });

  it('captures hunk body including +/- lines', () => {
    const hunks = parseDiffHunks(SAMPLE_DIFF);
    expect(hunks[0]!.body).toContain('+import { b } from \'./b\';');
    expect(hunks[0]!.body).toContain(' const x = 1;');
    expect(hunks[1]!.body).toContain('-  return 0;');
  });

  it('returns empty array on empty diff', () => {
    expect(parseDiffHunks('')).toEqual([]);
  });

  it('returns empty array when no hunk headers', () => {
    expect(parseDiffHunks('diff --git a/x b/x\njust some text\n')).toEqual([]);
  });
});

describe('renderDiffReview', () => {
  it('renders with file:line anchors', () => {
    const out = renderDiffReview(SAMPLE_DIFF);
    expect(out).toContain('src/foo.ts:1');
    expect(out).toContain('src/foo.ts:11');
    expect(out).toContain('src/bar.ts:1');
    expect(out).toContain('diff review:');
  });

  it('returns "no hunks to review" on empty diff', () => {
    expect(renderDiffReview('')).toBe('no hunks to review');
  });
});
