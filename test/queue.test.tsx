import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { Session } from '../src/session';
import { App, createApprovalBridge } from '../src/ui/App';
import { testHooks } from './helpers';

const usage = {
  inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2 },
} as any;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One assistant reply, delivered slowly enough to type during. */
const slowReply = (body: string): LanguageModelV4StreamPart[] => [
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', delta: body },
  { type: 'text-end', id: '0' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
];

function mount(chunkDelayInMs: number) {
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (opts) => {
      const last = opts.prompt.at(-1);
      const content = last?.content;
      prompts.push(typeof content === 'string' ? content : JSON.stringify(content));
      return {
        stream: simulateReadableStream({
          chunks: slowReply(`reply ${prompts.length}`),
          chunkDelayInMs,
          initialDelayInMs: null,
        }),
      };
    },
  });

  const bridge = createApprovalBridge();
  const session = new Session({ model, askApproval: bridge.ask });
  const app = render(<App session={session} bridge={bridge} header="hdr" hooks={testHooks()} />);
  return { app, prompts, session };
}

async function type(app: ReturnType<typeof render>, s: string) {
  for (const ch of s) {
    app.stdin.write(ch);
    await wait(25);
  }
  app.stdin.write('\r');
  await wait(60);
}

test('the input stays live while a turn runs, and a submission is queued', async () => {
  const { app, prompts } = mount(600);
  await wait(150);

  await type(app, 'first');
  await wait(200);

  // Mid-turn: the spinner and the input coexist rather than swapping. The
  // placeholder's first character is inverted for the cursor, hence the offset.
  const midTurn = app.lastFrame() ?? '';
  expect(midTurn).toContain('working...');
  expect(midTurn).toContain('ype to queue');

  await type(app, 'second');
  await wait(150);

  expect(app.lastFrame()).toContain('queued: 1');
  expect(prompts).toHaveLength(1);

  app.unmount();
}, 20_000);

test('two prompts typed during a turn run in order afterwards', async () => {
  const { app, prompts } = mount(400);
  await wait(150);

  await type(app, 'first');
  await wait(120);
  await type(app, 'second');
  await type(app, 'third');

  expect(app.lastFrame()).toContain('queued: 2');

  await wait(3000);

  expect(prompts).toHaveLength(3);
  expect(prompts[0]).toContain('first');
  expect(prompts[1]).toContain('second');
  expect(prompts[2]).toContain('third');
  expect(app.lastFrame()).not.toContain('queued:');

  app.unmount();
}, 25_000);

test('esc clears the queue as well as aborting the turn', async () => {
  const { app, prompts } = mount(800);
  await wait(150);

  await type(app, 'first');
  await wait(150);
  await type(app, 'queued one');
  await type(app, 'queued two');
  expect(app.lastFrame()).toContain('queued: 2');

  app.stdin.write('\u001B');
  await wait(1200);

  expect(app.lastFrame()).not.toContain('queued:');
  expect(prompts).toHaveLength(1);

  app.unmount();
}, 25_000);

test('reasoning shows as a collapsed line before any text arrives, then leaves with the turn', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'reasoning-start', id: 'r' },
          { type: 'reasoning-delta', id: 'r', delta: 'weighing the options at some length' },
          { type: 'reasoning-end', id: 'r' },
          { type: 'text-start', id: '0' },
          { type: 'text-delta', id: '0', delta: 'the answer' },
          { type: 'text-end', id: '0' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ] as LanguageModelV4StreamPart[],
        chunkDelayInMs: 250,
        initialDelayInMs: null,
      }),
    }),
  });

  const bridge = createApprovalBridge();
  const session = new Session({ model, askApproval: bridge.ask });
  const app = render(<App session={session} bridge={bridge} header="hdr" hooks={testHooks()} />);
  await wait(150);

  await type(app, 'think about it');
  await wait(700);

  const thinking = app.lastFrame() ?? '';
  expect(thinking).toContain('thinking...');
  expect(thinking).toContain('tokens');
  expect(thinking).not.toContain('weighing the options');

  await wait(2500);

  const done = app.lastFrame() ?? '';
  expect(done).toContain('the answer');
  expect(done).not.toContain('thinking');

  app.unmount();
}, 25_000);

test('the tool in flight is named on screen and cleared when it returns', async () => {
  const orig = process.cwd();
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const chunks: LanguageModelV4StreamPart[] =
        n++ === 0
          ? [
              { type: 'tool-input-start', id: 'c1', toolName: 'read_file' },
              { type: 'tool-input-end', id: 'c1' },
              {
                type: 'tool-call',
                toolCallId: 'c1',
                toolName: 'read_file',
                input: JSON.stringify({ path: 'src/session.ts' }),
              },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
            ]
          : [
              { type: 'text-start', id: '0' },
              { type: 'text-delta', id: '0', delta: 'read it' },
              { type: 'text-end', id: '0' },
              { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
            ];
      return { stream: simulateReadableStream({ chunks, chunkDelayInMs: 200, initialDelayInMs: null }) };
    },
  });

  try {
    const bridge = createApprovalBridge();
    const session = new Session({ model, askApproval: bridge.ask });
    const app = render(<App session={session} bridge={bridge} header="hdr" hooks={testHooks()} />);
    await wait(150);

    await type(app, 'read the session file');
    await wait(500);

    expect(app.lastFrame()).toContain('read_file');

    await wait(2500);
    expect(app.lastFrame()).toContain('read it');

    app.unmount();
  } finally {
    process.chdir(orig);
  }
}, 25_000);
