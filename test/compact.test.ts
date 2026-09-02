import { expect, test } from 'bun:test';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { ModelMessage } from 'ai';
import { Session, type AgentEvent } from '../src/session';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5 },
} as any;

const stream = (parts: LanguageModelV4StreamPart[]) => ({
  stream: simulateReadableStream({ chunks: parts, chunkDelayInMs: null, initialDelayInMs: null }),
});

const text = (body: string): LanguageModelV4StreamPart[] => [
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', delta: body },
  { type: 'text-end', id: '0' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
];

/** One assistant turn carrying a bulky tool call plus its result. */
function bulkyExchange(i: number): ModelMessage[] {
  return [
    { role: 'user', content: `question ${i}` },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: `t${i}`, toolName: 'read_file', input: { path: `f${i}.ts` } }],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: `t${i}`,
          toolName: 'read_file',
          output: { type: 'text', value: 'x'.repeat(5000) },
        },
      ],
    },
  ];
}

test('history under the threshold is sent untouched', async () => {
  const seen: LanguageModelV4CallOptions[] = [];
  const session = new Session({
    model: new MockLanguageModelV4({
      doStream: async (o) => {
        seen.push(o);
        return stream(text('ok'));
      },
    }),
    askApproval: async () => 'deny',
    messages: [...bulkyExchange(0)],
    compactThreshold: 1_000_000,
  });

  for await (const _ of session.send('next')) void _;

  expect(JSON.stringify(seen[0]?.prompt)).toContain('x'.repeat(5000));
});

test('history over the threshold is pruned before reaching the model', async () => {
  const messages = [...bulkyExchange(0), ...bulkyExchange(1), ...bulkyExchange(2), ...bulkyExchange(3)];
  const seen: LanguageModelV4CallOptions[] = [];
  const session = new Session({
    model: new MockLanguageModelV4({
      doStream: async (o) => {
        seen.push(o);
        return stream(text('ok'));
      },
    }),
    askApproval: async () => 'deny',
    messages: [...messages],
    compactThreshold: 1000,
  });

  const beforeTokens = session.estimatedTokens();
  expect(beforeTokens).toBeGreaterThan(1000);

  const events: string[] = [];
  for await (const ev of session.send('next')) events.push(ev.type);

  const sentSize = JSON.stringify(seen[0]?.prompt).length;
  expect(sentSize).toBeLessThan(JSON.stringify(messages).length);

  // Pruning is for the wire only; the local history keeps every message.
  expect(session.messages.length).toBeGreaterThan(messages.length);
  expect(events).toContain('compacted');
});

test('the compacted event reports the counts and arrives before done', async () => {
  const messages = [...bulkyExchange(0), ...bulkyExchange(1), ...bulkyExchange(2), ...bulkyExchange(3)];
  const session = new Session({
    model: new MockLanguageModelV4({ doStream: async () => stream(text('ok')) }),
    askApproval: async () => 'deny',
    messages: [...messages],
    compactThreshold: 1000,
  });

  const events: AgentEvent[] = [];
  for await (const ev of session.send('next')) events.push(ev);

  const compacted = events.find((e) => e.type === 'compacted');
  if (compacted?.type !== 'compacted') throw new Error('expected a compacted event');
  expect(compacted.before).toBeGreaterThan(compacted.after);
  expect(compacted.after).toBeGreaterThan(0);

  expect(events.findIndex((e) => e.type === 'compacted')).toBeLessThan(
    events.findIndex((e) => e.type === 'done'),
  );
});

test('history under the threshold emits no compacted event', async () => {
  const session = new Session({
    model: new MockLanguageModelV4({ doStream: async () => stream(text('ok')) }),
    askApproval: async () => 'deny',
    messages: [...bulkyExchange(0)],
    compactThreshold: 1_000_000,
  });

  const events: string[] = [];
  for await (const ev of session.send('next')) events.push(ev.type);
  expect(events).not.toContain('compacted');
});

test('summarize replaces the whole history with one summary message', async () => {
  let generateCalls = 0;
  const session = new Session({
    model: new MockLanguageModelV4({
      doGenerate: async () => {
        generateCalls++;
        return {
          content: [{ type: 'text', text: '- goal: add pagination\n- touched: src/users.ts\n- todo: add tests' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
          warnings: [],
        } as any;
      },
    }),
    askApproval: async () => 'deny',
    messages: [...bulkyExchange(0), ...bulkyExchange(1)],
  });

  const { before, after } = await session.summarize();

  expect(generateCalls).toBe(1);
  expect(before).toBe(6);
  expect(after).toBe(1);
  expect(session.messages).toHaveLength(1);
  expect(session.messages[0]?.role).toBe('user');
  expect(String(session.messages[0]?.content)).toContain('add pagination');
});

test('summarize on an empty session is a no-op', async () => {
  const session = new Session({
    model: new MockLanguageModelV4({ doGenerate: async () => ({}) as any }),
    askApproval: async () => 'deny',
  });
  expect(await session.summarize()).toEqual({ before: 0, after: 0 });
});

test('onChange fires for every history mutation so autosave stays current', async () => {
  const snapshots: number[] = [];
  const session = new Session({
    model: new MockLanguageModelV4({ doStream: async () => stream(text('ok')) }),
    askApproval: async () => 'deny',
    onChange: (m) => snapshots.push(m.length),
  });

  for await (const _ of session.send('hello')) void _;

  expect(snapshots).toEqual([1, 2]);
});
