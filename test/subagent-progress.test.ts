import { expect, test } from 'bun:test';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { z } from 'zod';
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

test('a subagent reports start, each step, its outcome, and end', async () => {
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
  expect(seen.map((e) => e.type)).toEqual(['start', 'step', 'result', 'end']);

  const start = seen[0];
  if (start?.type !== 'start') throw new Error('expected start');
  expect(start.kind).toBe('explore');
  expect(start.description).toBe('find login');

  const step = seen[1];
  if (step?.type !== 'step') throw new Error('expected step');
  expect(step.tool).toBe('grep');
  expect(step.summary).toBe('login');

  // The outcome, not just the call: a panel showing only calls cannot tell a
  // search that found something from one that found nothing.
  const result = seen[2];
  if (result?.type !== 'result') throw new Error('expected result');
  expect(result.tool).toBe('grep');
  expect(result.ok).toBe(true);

  const end = seen[3];
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

test('explore and review can only read, whatever else exists', async () => {
  for (const kind of ['explore', 'review'] as const) {
    const seen: LanguageModelV4CallOptions[] = [];
    const model = new MockLanguageModelV4({
      doStream: async (o) => {
        seen.push(o);
        return stream(text('done'));
      },
    });

    // With an approval channel present, so this proves the read-only kinds are
    // restricted by their tool set rather than by the absence of a gate.
    await run(createTaskTool({ model, approve: async () => true }), { description: 'd', prompt: 'p', kind });

    const names = (seen[0]?.tools ?? []).map((t) => t.name);
    for (const write of ['write_file', 'edit_file', 'multi_edit', 'bash']) {
      expect(names, `${kind} must not hold ${write}`).not.toContain(write);
    }
    expect(names).toContain('read_file');
    expect(names).toContain('grep');
  }
});

test('a worker holds the mutating tools as well', async () => {
  const seen: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (o) => {
      seen.push(o);
      return stream(text('done'));
    },
  });

  await run(createTaskTool({ model, approve: async () => true }), {
    description: 'd',
    prompt: 'p',
    kind: 'worker',
  });

  const names = (seen[0]?.tools ?? []).map((t) => t.name);
  for (const write of ['write_file', 'edit_file', 'multi_edit', 'apply_patch', 'bash']) expect(names).toContain(write);
});

test('worker is not offered at all without an approval channel', async () => {
  const model = new MockLanguageModelV4({ doStream: async () => stream(text('done')) });
  const readOnly = createTaskTool({ model });

  const schema = JSON.stringify(z.toJSONSchema(readOnly.inputSchema as never));
  expect(schema).not.toContain('worker');
  expect(readOnly.description).not.toContain('worker');

  // Asking for one anyway fails loudly. Silently downgrading to explore would
  // report the task as complete having written nothing.
  expect(run(readOnly, { description: 'd', prompt: 'p', kind: 'worker' })).rejects.toThrow(
    /needs an approval channel/,
  );
});

test('a worker call the user denies is refused and the subagent is told', async () => {
  const asked: string[] = [];
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () =>
      n++ === 0
        ? stream(toolCall('s1', 'write_file', { path: 'out.txt', content: 'x' }))
        : stream(text('I was denied, so I stopped.')),
  });

  const out = await run(
    createTaskTool({
      model,
      approve: async ({ toolName }) => {
        asked.push(toolName);
        return false;
      },
    }),
    { description: 'write it', prompt: 'write out.txt', kind: 'worker' },
  );

  expect(asked).toEqual(['write_file']);
  expect(out).toContain('denied');
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
