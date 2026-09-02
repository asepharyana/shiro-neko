import { expect, test } from 'bun:test';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { Session } from '../src/session';
import { createTaskTool, type SubagentEvent } from '../src/subagent';

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2 },
} as any;

const stream = (parts: LanguageModelV4StreamPart[]) => ({
  stream: simulateReadableStream({ chunks: parts, chunkDelayInMs: null, initialDelayInMs: null }),
});

const toolCall = (id: string, toolName: string, input: unknown): LanguageModelV4StreamPart[] => [
  { type: 'tool-input-start', id, toolName },
  { type: 'tool-input-end', id },
  { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
];

const text = (body: string): LanguageModelV4StreamPart[] => [
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', delta: body },
  { type: 'text-end', id: '0' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
];

const run = (tool: ReturnType<typeof createTaskTool>, input: Record<string, unknown>) =>
  Promise.resolve(tool.execute!(input as never, { toolCallId: 'x', messages: [] } as never)) as Promise<string>;

test('a subagent reports start, each step, and end', async () => {
  const seen: SubagentEvent[] = [];
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () =>
      n++ === 0
        ? stream(toolCall('s1', 'grep', { pattern: 'login' }))
        : stream(text('login lives at src/auth.ts:12')),
  });

  const out = await run(createTaskTool({ model, report: (e) => seen.push(e) }), {
    description: 'find login',
    prompt: 'where is login handled',
  });

  expect(out).toContain('src/auth.ts:12');
  expect(seen.map((e) => e.type)).toEqual(['start', 'step', 'end']);

  const start = seen[0];
  if (start?.type !== 'start') throw new Error('expected start');
  expect(start.kind).toBe('explore');
  expect(start.description).toBe('find login');

  const step = seen[1];
  if (step?.type !== 'step') throw new Error('expected step');
  expect(step.tool).toBe('grep');
  expect(step.summary).toBe('login');

  const end = seen[2];
  if (end?.type !== 'end') throw new Error('expected end');
  expect(end).toMatchObject({ ok: true, steps: 1 });
});

test('the review kind gets a different system prompt', async () => {
  const seen: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (o) => {
      seen.push(o);
      return stream(text('looks correct'));
    },
  });

  await run(createTaskTool({ model }), { description: 'review it', prompt: 'review src/x.ts', kind: 'review' });
  const system = JSON.stringify(seen[0]?.prompt.find((m) => m.role === 'system'));
  expect(system).toContain('review subagent');
  expect(system).toContain('Severity order');
});

test('explore is the default kind', async () => {
  const seen: SubagentEvent[] = [];
  const model = new MockLanguageModelV4({ doStream: async () => stream(text('found it')) });
  await run(createTaskTool({ model, report: (e) => seen.push(e) }), { description: 'd', prompt: 'p' });
  const start = seen[0];
  if (start?.type !== 'start') throw new Error('expected start');
  expect(start.kind).toBe('explore');
});

test('a subagent only ever gets read-only tools', async () => {
  const seen: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (o) => {
      seen.push(o);
      return stream(text('done'));
    },
  });

  await run(createTaskTool({ model }), { description: 'd', prompt: 'p' });
  const names = (seen[0]?.tools ?? []).map((t) => t.name).sort();
  expect(names).toEqual(['glob', 'grep', 'read_file']);
});

test('an empty report is stated rather than returned blank', async () => {
  const model = new MockLanguageModelV4({ doStream: async () => stream(text('   ')) });
  const seen: SubagentEvent[] = [];
  const out = await run(createTaskTool({ model, report: (e) => seen.push(e) }), { description: 'd', prompt: 'p' });

  expect(out).toContain('no findings');
  const end = seen.at(-1);
  if (end?.type !== 'end') throw new Error('expected end');
  expect(end.ok).toBe(false);
});

test('a failing subagent reports an error event and rethrows', async () => {
  const seen: SubagentEvent[] = [];
  const model = new MockLanguageModelV4({
    doStream: async () => {
      throw new Error('upstream refused');
    },
  });

  expect(run(createTaskTool({ model, report: (e) => seen.push(e) }), { description: 'd', prompt: 'p' })).rejects.toThrow(
    /upstream refused/,
  );
  await Bun.sleep(50);

  const error = seen.at(-1);
  if (error?.type !== 'error') throw new Error('expected error');
  expect(error.message).toContain('upstream refused');
});

test('the subagent never sees the parent conversation', async () => {
  const seen: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (o) => {
      seen.push(o);
      return stream(text('ok'));
    },
  });

  await run(createTaskTool({ model }), { description: 'd', prompt: 'ONLY-THIS-PROMPT' });
  const sent = JSON.stringify(seen[0]?.prompt);
  expect(sent).toContain('ONLY-THIS-PROMPT');
});

test('reporting is optional, so a headless run needs no wiring', async () => {
  const model = new MockLanguageModelV4({ doStream: async () => stream(text('fine')) });
  expect(await run(createTaskTool({ model }), { description: 'd', prompt: 'p' })).toBe('fine');
});

test('through a Session the task tool still needs no approval', async () => {
  const seen: SubagentEvent[] = [];
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const i = n++;
      if (i === 0) return stream(toolCall('c1', 'task', { description: 'look', prompt: 'find x' }));
      if (i === 1) return stream(text('subagent says x is in src/a.ts'));
      return stream(text('the parent summary'));
    },
  });

  const session = new Session({
    model,
    askApproval: async () => {
      throw new Error('task must not prompt');
    },
    extraTools: { task: createTaskTool({ model, report: (e) => seen.push(e) }) },
    autoApprove: ['task'],
  });

  const kinds: string[] = [];
  for await (const ev of session.send('where is x')) kinds.push(ev.type);

  expect(kinds).toContain('tool-result');
  expect(kinds).not.toContain('tool-denied');
  expect(seen.map((e) => e.type)).toContain('end');
});
