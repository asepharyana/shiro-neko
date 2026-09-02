import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { Session } from '../src/session';
import { App, createApprovalBridge } from '../src/ui/App';
import { testHooks } from './helpers';

const usage = { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1 } } as any;

const model = new MockLanguageModelV4({
  doStream: async () =>
    ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: '0' },
          { type: 'text-delta', id: '0', delta: 'reply' },
          { type: 'text-end', id: '0' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ],
        chunkDelayInMs: null,
        initialDelayInMs: null,
      }),
    }) as any,
});

const paths = ['README.md', 'src/app.ts', 'src/session.ts', 'src/ui/App.tsx', 'test/session.test.ts'];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOWN = '\u001B[B';
const TAB = '\t';

function mount(listPaths = async () => paths) {
  const sent: string[] = [];
  const bridge = createApprovalBridge();
  const session = new Session({ model, askApproval: bridge.ask });
  const app = render(
    <App
      session={session}
      bridge={bridge}
      header="hdr"
      hooks={testHooks({ listPaths, recordPrompt: (t) => sent.push(t) })}
    />,
  );
  return { app, sent };
}

async function type(app: ReturnType<typeof render>, s: string) {
  for (const ch of s) {
    app.stdin.write(ch);
    await wait(30);
  }
}

test('@ opens the file picker and typing narrows it', async () => {
  const { app } = mount();
  await wait(150);

  await type(app, '@');
  await wait(200);
  expect(app.lastFrame()).toContain('README.md');

  await type(app, 'src/ui/');
  await wait(200);

  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('src/ui/App.tsx');
  expect(frame).not.toContain('README.md');
  expect(frame).not.toContain('test/session.test.ts');

  app.unmount();
}, 25_000);

test('tab inserts the highlighted path with no @', async () => {
  const { app } = mount();
  await wait(150);

  await type(app, 'explain @src/ses');
  await wait(200);
  expect(app.lastFrame()).toContain('src/session.ts');

  app.stdin.write(TAB);
  await wait(250);

  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('explain src/session.ts');
  expect(frame).not.toContain('@src');
  expect(frame).not.toContain('up/down move | tab or enter insert');

  app.unmount();
}, 25_000);

test('down then tab inserts the second match', async () => {
  const { app } = mount();
  await wait(150);

  await type(app, '@src/');
  await wait(200);
  app.stdin.write(DOWN);
  await wait(150);
  app.stdin.write(TAB);
  await wait(250);

  expect(app.lastFrame()).toContain('src/session.ts');

  app.unmount();
}, 25_000);

test('a completed prompt submits as a plain path', async () => {
  const { app, sent } = mount();
  await wait(150);

  await type(app, '@src/app');
  await wait(200);
  app.stdin.write(TAB);
  await wait(250);
  app.stdin.write('\r');
  await wait(400);

  expect(sent).toHaveLength(1);
  expect(sent[0]).toBe('src/app.ts');

  app.unmount();
}, 25_000);

test('esc dismisses the picker and leaves the text alone', async () => {
  const { app } = mount();
  await wait(150);

  await type(app, '@src/');
  await wait(200);
  expect(app.lastFrame()).toContain('src/app.ts');

  app.stdin.write('\u001B');
  await wait(250);

  const frame = app.lastFrame() ?? '';
  expect(frame).not.toContain('tab or enter insert');
  expect(frame).toContain('@src/');

  app.unmount();
}, 25_000);

test('a query matching nothing says so instead of showing a stale list', async () => {
  const { app } = mount();
  await wait(150);

  await type(app, '@zzzz');
  await wait(250);

  expect(app.lastFrame()).toContain('no file matches zzzz');

  app.unmount();
}, 25_000);

test('an @ inside a word is not a completion', async () => {
  const { app } = mount();
  await wait(150);

  await type(app, 'mail me@example');
  await wait(250);

  const frame = app.lastFrame() ?? '';
  expect(frame).not.toContain('tab or enter insert');
  expect(frame).not.toContain('no file matches');

  app.unmount();
}, 25_000);

test('the walk is reported as loading and only runs once', async () => {
  let calls = 0;
  const { app } = mount(async () => {
    calls++;
    await wait(400);
    return paths;
  });
  await wait(150);

  await type(app, '@');
  await wait(80);
  expect(app.lastFrame()).toContain('indexing files');

  await wait(600);
  expect(app.lastFrame()).toContain('README.md');

  // Dismiss, reopen: the list is cached rather than walked again.
  app.stdin.write('\u001B');
  await wait(150);
  await type(app, ' @src/');
  await wait(300);

  expect(app.lastFrame()).toContain('src/app.ts');
  expect(calls).toBe(1);

  app.unmount();
}, 25_000);

test('the command menu still works and does not fight the file picker', async () => {
  const { app } = mount();
  await wait(150);

  await type(app, '/mo');
  await wait(200);

  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('models');
  expect(frame).not.toContain('tab or enter insert');

  app.unmount();
}, 25_000);

test('ctrl-c with nothing running does not kill a command that is not there', async () => {
  const { app } = mount();
  await wait(150);

  app.stdin.write('\u0003');
  await wait(250);

  expect(app.lastFrame() ?? '').not.toContain('interrupted:');

  app.unmount();
}, 25_000);
