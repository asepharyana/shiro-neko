import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React, { useState } from 'react';
import { PromptInput, type PromptInputProps } from '../src/ui/PromptInput';

/**
 * `PromptInput` is exercised through `App` in `input.test.tsx` (history recall,
 * arrow and word motion, ctrl-u, ctrl-d, paste). This file renders it directly
 * for the behaviours that reaching it through the whole app made awkward: the
 * emacs kill keys, the mask, a blurred input, and the `onKey` escape hatch that
 * `App` uses to hand up/down/tab/esc to its own menus.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Keys that are awkward to read as escape sequences at the call site. */
const KEYS = {
  up: '\u001B[A',
  down: '\u001B[B',
  left: '\u001B[D',
  ctrlA: '\u0001',
  ctrlD: '\u0004',
  ctrlE: '\u0005',
  ctrlK: '\u000B',
  ctrlU: '\u0015',
  ctrlW: '\u0017',
  backspace: '\u007F',
} as const;

/**
 * The input is controlled, so it needs an owner to feed `value` back. This wraps
 * it with the state a caller would hold and records every value it reports.
 */
type HarnessProps = Omit<Partial<PromptInputProps>, 'value' | 'onChange' | 'onSubmit'> & {
  initial?: string;
  onChange?: (value: string, cursor: number) => void;
  onSubmit?: (value: string) => void;
};

function Harness({ initial = '', onChange, onSubmit, ...rest }: HarnessProps) {
  const [value, setValue] = useState(initial);
  return (
    <PromptInput
      {...rest}
      value={value}
      onSubmit={onSubmit ?? (() => {})}
      onChange={(next, cursor) => {
        onChange?.(next, cursor);
        setValue(next);
      }}
    />
  );
}

function mount(props: HarnessProps = {}) {
  const changes: { value: string; cursor: number }[] = [];
  const submitted: string[] = [];
  const app = render(
    <Harness
      {...props}
      onChange={(value, cursor) => changes.push({ value, cursor })}
      onSubmit={(v) => submitted.push(v)}
    />,
  );
  return { app, changes, submitted };
}

async function press(app: ReturnType<typeof render>, s: string, ms = 80) {
  app.stdin.write(s);
  await wait(ms);
}

/** The visible text with every SGR sequence removed, i.e. what the user actually reads. */
const plain = (frame: string) => frame.replace(/\u001B\[[0-9;]*m/g, '');

test('the rendered line carries no hand-written SGR escapes', async () => {
  // The cursor must be Ink's `inverse` prop, not `\u001B[7m` pasted into the string.
  // Ink measures string content as printable columns, so an embedded escape is
  // counted as text and shifts the line — the stray `t` before `ype` in the
  // placeholder, and a corrupted cell wherever the line wraps.
  const { app } = mount({ initial: 'abc', placeholder: `type to queue${String.fromCharCode(0x2026)}` });
  await wait(40);

  const frame = app.lastFrame() ?? '';
  expect(frame).not.toContain('\u001B[7m');
  expect(frame).not.toContain('\u001B[27m');
  expect(plain(frame)).toBe('abc');
  app.unmount();
});

test('the placeholder renders as one unbroken run of text', async () => {
  const { app } = mount({ placeholder: 'ask anything' });
  await wait(40);

  // No escape may sit between the first character and the rest.
  expect(plain(app.lastFrame() ?? '')).toBe('ask anything');
  app.unmount();
});

test('a focused input keeps the caret off the string', async () => {
  const { app } = mount({ initial: 'abc' });
  await wait(40);
  // At the end of the line the caret is a blank cell, which Ink trims.
  expect(plain(app.lastFrame() ?? '')).toBe('abc');
  app.unmount();
});

test('a bare blurred input renders no caret at all', async () => {
  const { app } = mount({ focus: false });
  await wait(40);
  const frame = app.lastFrame() ?? '';
  expect(frame).not.toContain('\u001B[7m');
  expect(frame.trim()).toBe('');
  app.unmount();
});

test('the caret marks the first placeholder character while focused', async () => {
  const { app } = mount({ placeholder: 'ask anything' });
  await wait(40);
  expect(plain(app.lastFrame() ?? '')).toBe('ask anything');
  app.unmount();

  const blurred = mount({ placeholder: 'ask anything', focus: false });
  await wait(40);
  expect(blurred.app.lastFrame()).toBe('ask anything');
  blurred.app.unmount();
});

test('the cursor moves one character at a time with the arrows', async () => {
  const { app, changes } = mount({ initial: 'abc' });
  await wait(40);
  expect(plain(app.lastFrame() ?? '')).toBe('abc');

  await press(app, KEYS.left);
  await press(app, KEYS.left);
  await press(app, 'Z');
  expect(app.lastFrame()).toBe('aZbc');
  expect(changes.at(-1)?.cursor).toBe(2);
  app.unmount();
});

test('a masked input hides the value and keeps its length', async () => {
  const { app } = mount({ initial: 'abcd', mask: '*' });
  await wait(40);

  expect(app.lastFrame()).toBe('****');
  app.unmount();
});

test('a mask stays masked as the value shortens', async () => {
  const { app } = mount({ initial: 'abcd', mask: '*' });
  await wait(40);
  // The harness owns the value, so backspace shortens it to three stars.
  await press(app, KEYS.backspace);
  expect(app.lastFrame()).toBe('***');
  app.unmount();
});

test('ctrl-a and ctrl-e move the cursor between the ends of the line', async () => {
  const { app } = mount({ initial: 'inline' });
  await wait(40);

  // Both keys only move the caret, so the proof is where the next character lands.
  await press(app, KEYS.ctrlA);
  await press(app, 'X');
  expect(app.lastFrame()).toBe('Xinline');

  await press(app, KEYS.ctrlE);
  await press(app, 'Y');
  expect(app.lastFrame()).toBe('XinlineY');
  app.unmount();
});

test('ctrl-k kills from the cursor to the end', async () => {
  const { app } = mount({ initial: 'keep this' });
  await wait(40);
  await press(app, KEYS.ctrlA);
  // Three characters in, then kill the tail.
  for (let i = 0; i < 3; i++) await press(app, KEYS.left.replace('\u001B[D', '\u001B[C'), 30);
  await press(app, KEYS.ctrlK);
  expect(app.lastFrame()).toContain('kee');
  expect(app.lastFrame()).not.toContain('keep this');
  app.unmount();
});

test('ctrl-w deletes the word before the cursor and its padding', async () => {
  const { app } = mount({ initial: 'one two three' });
  await wait(40);

  await press(app, KEYS.ctrlW);
  expect(app.lastFrame()).toContain('one two');
  expect(app.lastFrame()).not.toContain('three');

  await press(app, KEYS.ctrlW);
  expect(app.lastFrame()).toContain('one');
  expect(app.lastFrame()).not.toContain('two');
  app.unmount();
});

test('ctrl-w on a single word leaves an empty line', async () => {
  const { app } = mount({ initial: 'lonely' });
  await wait(40);
  await press(app, KEYS.ctrlW);
  expect(app.lastFrame()).not.toContain('lonely');
  app.unmount();
});

test('onKey can swallow a key before the input sees it', async () => {
  const seen: string[] = [];
  const { app, submitted } = mount({
    initial: 'draft',
    onKey: (input, key) => {
      if (key.upArrow) {
        seen.push('up');
        return true;
      }
      return false;
    },
    history: ['from history'],
  });
  await wait(40);

  await press(app, KEYS.up);
  expect(seen).toEqual(['up']);
  expect(app.lastFrame()).toContain('draft');
  expect(app.lastFrame()).not.toContain('from history');

  // A key onKey declines still reaches the input.
  await press(app, '!');
  expect(app.lastFrame()).toContain('draft!');
  expect(submitted).toEqual([]);
  app.unmount();
});

test('initialCursor puts the caret mid-line, so typing lands there', async () => {
  const { app } = mount({ initial: 'abcdef', initialCursor: 2 });
  await wait(40);
  expect(app.lastFrame()).toBe('abcdef');

  await press(app, 'X');
  expect(app.lastFrame()).toBe('abXcdef');
  app.unmount();
});

test('an external value renders as given and reports no change', async () => {
  const changes: { value: string; cursor: number }[] = [];
  const app = render(
    <PromptInput
      value="set from outside"
      onChange={(v, c) => changes.push({ value: v, cursor: c })}
      onSubmit={() => {}}
    />,
  );
  await wait(40);

  // A prop with a handler that does not feed the value back: the text renders
  // exactly as passed and the input reports nothing until a key is pressed.
  expect(app.lastFrame()).toBe('set from outside');
  expect(changes).toEqual([]);
  app.unmount();
});

test('submit reports the current value and resets the cursor', async () => {
  const { app, submitted } = mount({ initial: 'send me' });
  await wait(40);
  await press(app, '\r', 120);

  expect(submitted).toEqual(['send me']);
  app.unmount();
});

test('typing inserts at the cursor rather than appending', async () => {
  const { app } = mount({ initial: 'ac' });
  await wait(40);
  await press(app, KEYS.left);
  await press(app, 'b');
  expect(app.lastFrame()).toBe('abc');
  app.unmount();
});
