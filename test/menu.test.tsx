import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { Session } from '../src/session';
import { App, createApprovalBridge, type AppHooks } from '../src/ui/App';
import { testHooks } from './helpers';

const usage = {
  inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1 },
} as any;

const model = new MockLanguageModelV4({
  doStream: async () =>
    ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: '0' },
          { type: 'text-delta', id: '0', delta: 'answer' },
          { type: 'text-end', id: '0' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ],
        chunkDelayInMs: null,
        initialDelayInMs: null,
      }),
    }) as any,
});

function mount(over: Partial<AppHooks> = {}) {
  const bridge = createApprovalBridge();
  const session = new Session({ model, askApproval: bridge.ask });
  const app = render(<App session={session} bridge={bridge} header="hdr" hooks={testHooks(over)} />);
  return { app, session };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOWN = '\u001B[B';
const UP = '\u001B[A';

async function press(app: ReturnType<typeof render>, s: string, ms = 130) {
  app.stdin.write(s);
  await wait(ms);
}

test('typing a slash opens the menu listing every command', async () => {
  const { app } = mount();
  await wait(150);
  expect(app.lastFrame()).not.toContain('/compact');

  await press(app, '/');
  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('/help');
  expect(frame).toContain('/provider');
  expect(frame).toContain('/compact');
  expect(frame).toContain('tab complete');

  app.unmount();
}, 10_000);

test('the menu narrows as more characters are typed', async () => {
  const { app } = mount();
  await wait(150);
  await press(app, '/');
  await press(app, 'c');
  await press(app, 'o');

  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('/compact');
  expect(frame).toContain('/cost');
  expect(frame).not.toContain('/provider');

  app.unmount();
}, 10_000);

test('tab completes the highlighted entry into the input', async () => {
  const { app } = mount();
  await wait(150);
  await press(app, '/');
  await press(app, 'c');
  await press(app, 'o');
  await press(app, 's');
  await press(app, '\t');

  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('> /cost');
  expect(frame).not.toContain('tab complete');

  app.unmount();
}, 10_000);

test('up and down move the highlight and wrap around', async () => {
  const { app } = mount();
  await wait(150);
  await press(app, '/');
  await press(app, 'm');
  await press(app, 'o');
  await press(app, UP);
  await press(app, '\t');

  expect(app.lastFrame()).toContain('> /model');
  expect(app.lastFrame()).not.toContain('/models  ');

  app.unmount();
}, 10_000);

test('enter on an open menu runs the highlighted command, not the raw text', async () => {
  const seen: string[] = [];
  const { app } = mount({
    listModels: async () => {
      seen.push('listModels');
      return { models: [] };
    },
  });
  await wait(150);
  await press(app, '/');
  await press(app, 'm');
  await press(app, 'o');
  await press(app, '\r', 500);

  expect(seen).toEqual(['listModels']);
  expect(app.lastFrame()).toContain('> /models');

  app.unmount();
}, 10_000);

test('esc dismisses the menu and leaves the typed text alone', async () => {
  const { app } = mount();
  await wait(150);
  await press(app, '/');
  await press(app, 'c');
  expect(app.lastFrame()).toContain('/compact');

  await press(app, '\u001B', 200);
  const frame = app.lastFrame() ?? '';
  expect(frame).not.toContain('tab complete');
  expect(frame).toContain('> /c');

  app.unmount();
}, 10_000);

test('an unknown slash word shows no menu and reports on submit', async () => {
  const { app } = mount();
  await wait(150);
  for (const ch of '/zzz') await press(app, ch, 90);
  expect(app.lastFrame()).not.toContain('tab complete');

  await press(app, '\r', 400);
  expect(app.lastFrame()).toContain('unknown command /zzz');

  app.unmount();
}, 10_000);

test('the menu closes once an argument is being typed', async () => {
  const { app } = mount();
  await wait(150);
  for (const ch of '/resume') await press(app, ch, 70);
  expect(app.lastFrame()).toContain('/resume <id>');

  await press(app, ' ', 150);
  expect(app.lastFrame()).not.toContain('tab complete');

  app.unmount();
}, 15_000);

test('plain prose never triggers the menu and still reaches the model', async () => {
  const { app, session } = mount();
  await wait(150);
  for (const ch of 'hello') await press(app, ch, 60);
  expect(app.lastFrame()).not.toContain('tab complete');

  await press(app, '\r', 500);
  expect(app.lastFrame()).toContain('answer');
  expect(session.messages[0]?.content).toBe('hello');

  app.unmount();
}, 15_000);
