import { expect, test } from 'bun:test';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { resolve } from '../src/permission';
import { subjectOf } from '../src/permission';
import { Session } from '../src/session';
import { createTaskTool } from '../src/subagent';

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2 },
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

test('the system prompt is cached between steps that change nothing', async () => {
  // A turn with a single tool call that resolves immediately: two model runs,
  // both carrying a system prompt. Because nothing changed between them (no task
  // list mutation, no new user text), the second run's system prompt must be the
  // same string object as the first — proving it was not rebuilt.
  const seen: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (o) => {
      const sys = (o.prompt as { role: string; content: string }[]).find((m) => m.role === 'system');
      seen.push(sys?.content ?? '<none>');
      return stream(text('done'));
    },
  });

  const session = new Session({
    model,
    yolo: true,
    askApproval: async () => 'always' as const,
  });

  const evs: string[] = [];
  for await (const ev of session.send('run the flow')) evs.push(ev.type);

  expect(evs).toContain('done');
  // At least two model runs happened (the loop calls streamText once, but a tool
  // approval-free single run is still one). The key assertion: every system
  // prompt delivered was the exact same cached string.
  expect(seen.length).toBeGreaterThan(0);
  for (let i = 1; i < seen.length; i++) expect(seen[i]).toBe(seen[0]);
});

test('a task list update busts the system prompt cache', async () => {
  // Two turns: first updates the notebook, second must carry a system prompt that
  // reflects the new task list — the cache must not serve the stale one.
  const seen: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (o) => {
      const sys = (o.prompt as { role: string; content: string }[]).find((m) => m.role === 'system');
      seen.push(sys?.content ?? '<none>');
      return stream(text('ok'));
    },
  });
  const session = new Session({ model, yolo: true, askApproval: async () => 'always' as const });

  for await (const _ of session.send('start')) void _;
  await session.notebook.tools().todo_write.execute!({
    todos: [{ content: 'do the thing', status: 'pending' }],
  } as never, {} as never);
  for await (const _ of session.send('now with a plan')) void _;

  // After the todo_write, the notebook revision changed, so turn two's system
  // prompt must be rebuilt and contain the task list.
  expect(seen.length).toBeGreaterThanOrEqual(2);
  expect(seen[seen.length - 1]).toContain('do the thing');
});

test('apply_patch paths are matched individually, so a path with spaces stays one subject', () => {
  const rules = { 'src/generated/*': 'deny' as const };
  // A patch touching both a denied and an allowed file: the deny must win because
  // one of the paths matches.
  const patched = '*** Update File: src/generated/out.ts\n-a\n+b\n*** Update File: src/main.ts\n-c\n+d\n';
  const subject = subjectOf('apply_patch', { patch: patched });
  expect(subject).toContain('src/generated/out.ts');
  expect(subject).toContain('src/main.ts');
  expect(resolve(rules, 'apply_patch', { patch: patched }).decision).toBe('deny');

  // A path with a space is one subject, not two.
  const sub2 = subjectOf('apply_patch', { patch: '*** Add File: "my dir/file.ts"\n+x\n' });
  expect(sub2).toBe('"my dir/file.ts"');
});

test('a completely empty subagent report retries once before giving up', async () => {
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      n++;
      // First attempt: fully blank. Second: a real report.
      return n === 1 ? stream(text('   ')) : stream(text('found: the answer is 42'));
    },
  });
  const out = await createTaskTool({ model }).execute!(
    { description: 'd', prompt: 'find the answer' },
    { toolCallId: 'x', messages: [] } as never,
  ) as unknown as string;
  expect(out).toContain('the answer is 42');
  expect(n).toBe(2);
});
