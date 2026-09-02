import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { Session } from '../src/session';
import { App, createApprovalBridge, type AppHooks } from '../src/ui/App';
import { testHooks } from './helpers';

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1 },
} as any;

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

function mount(over: Partial<AppHooks> = {}) {
  const bridge = createApprovalBridge();
  const session = new Session({ model, askApproval: bridge.ask });
  const app = render(<App session={session} bridge={bridge} header="hdr" hooks={testHooks(over)} />);
  return { app, session };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOWN = '\u001B[B';

async function press(app: ReturnType<typeof render>, s: string, ms = 90) {
  app.stdin.write(s);
  await wait(ms);
}

async function run(app: ReturnType<typeof render>, command: string, settle = 350) {
  for (const ch of command) await press(app, ch, 45);
  await press(app, '\r', settle);
}

test('/agent with a name switches without opening a picker', async () => {
  const picked: string[] = [];
  const { app } = mount({
    switchAgent: (name) => {
      picked.push(name);
      return `agent is now ${name}`;
    },
  });
  await wait(150);

  await run(app, '/agent deep');

  expect(picked).toEqual(['deep']);
  expect(app.lastFrame()).toContain('agent is now deep');
  expect(app.lastFrame()).not.toContain('Choose an agent');

  app.unmount();
}, 20_000);

test('/agent with no name opens the picker listing every variant', async () => {
  const { app } = mount();
  await wait(150);

  await run(app, '/agent');

  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('Choose an agent');
  expect(frame).toContain('default');
  expect(frame).toContain('quick');
  expect(frame).toContain('deep');
  expect(frame).toContain('plan');
  expect(frame).toContain('review');

  app.unmount();
}, 20_000);

test('selecting from the agent picker applies the choice', async () => {
  const picked: string[] = [];
  const { app } = mount({
    switchAgent: (name) => {
      picked.push(name);
      return `agent is now ${name}`;
    },
  });
  await wait(150);

  await run(app, '/agent');
  await press(app, DOWN, 120);
  await press(app, '\r', 300);

  expect(picked).toEqual(['quick']);
  expect(app.lastFrame()).not.toContain('Choose an agent');

  app.unmount();
}, 20_000);

test('esc dismisses the agent picker without switching', async () => {
  const picked: string[] = [];
  const { app } = mount({
    switchAgent: (name) => {
      picked.push(name);
      return name;
    },
  });
  await wait(150);

  await run(app, '/agent');
  expect(app.lastFrame()).toContain('Choose an agent');

  await press(app, '\u001B', 250);
  expect(app.lastFrame()).not.toContain('Choose an agent');
  expect(picked).toEqual([]);

  app.unmount();
}, 20_000);

test('/think with a level switches directly', async () => {
  const levels: string[] = [];
  const { app } = mount({
    switchThinking: (level) => {
      levels.push(level);
      return `thinking is now ${level}`;
    },
  });
  await wait(150);

  await run(app, '/think max');

  expect(levels).toEqual(['max']);
  expect(app.lastFrame()).toContain('thinking is now max');

  app.unmount();
}, 20_000);

test('/think with no level opens the picker listing the five levels', async () => {
  const { app } = mount();
  await wait(150);

  await run(app, '/think');

  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('Thinking level');
  for (const level of ['off', 'low', 'medium', 'high', 'max']) expect(frame).toContain(level);

  app.unmount();
}, 20_000);

test('an invalid thinking level is reported, not applied', async () => {
  const { app } = mount({
    switchThinking: () => {
      throw new Error('Unknown thinking level "ludicrous"');
    },
  });
  await wait(150);

  await run(app, '/think ludicrous');
  expect(app.lastFrame()).toContain('Unknown thinking level');

  app.unmount();
}, 20_000);

test('/skills lists what loaded', async () => {
  const { app } = mount({ listSkills: () => 'debug      builtin  Track down a bug' });
  await wait(150);

  await run(app, '/skills');
  expect(app.lastFrame()).toContain('Track down a bug');

  app.unmount();
}, 20_000);

test('/plugins lists what is active', async () => {
  const { app } = mount({ listPlugins: () => 'guard    refuses irreversible shell commands' });
  await wait(150);

  await run(app, '/plugins');
  expect(app.lastFrame()).toContain('refuses irreversible shell commands');

  app.unmount();
}, 20_000);

test('/notes reports the durable memory', async () => {
  const { app } = mount({ listMemory: async () => '(command) release with bun run release' });
  await wait(150);

  await run(app, '/notes');
  expect(app.lastFrame()).toContain('release with bun run release');

  app.unmount();
}, 20_000);

test('/memory compacts and reports the result', async () => {
  let called = 0;
  const { app } = mount({
    summarizeMemory: async () => {
      called++;
      return 'memory compacted: 40 entries into 12';
    },
  });
  await wait(150);

  await run(app, '/memory', 600);

  expect(called).toBe(1);
  expect(app.lastFrame()).toContain('40 entries into 12');

  app.unmount();
}, 20_000);

test('a failing /memory surfaces the error instead of crashing', async () => {
  const { app } = mount({
    summarizeMemory: async () => {
      throw new Error('no model available to summarize memory');
    },
  });
  await wait(150);

  await run(app, '/memory', 600);
  expect(app.lastFrame()).toContain('no model available');

  app.unmount();
}, 20_000);

test('the prompt input returns after a picker closes', async () => {
  const { app } = mount();
  await wait(150);

  await run(app, '/think');
  expect(app.lastFrame()).not.toContain('sk shiro-neko');

  await press(app, '\u001B', 250);
  expect(app.lastFrame()).toContain('sk shiro-neko');

  app.unmount();
}, 20_000);
