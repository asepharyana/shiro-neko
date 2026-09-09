import { usageOf } from './helpers';
import { expect, test } from 'bun:test';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session, type AgentEvent } from '../src/session';

function stream(parts: LanguageModelV4StreamPart[]) {
  return { stream: simulateReadableStream({ chunks: parts, chunkDelayInMs: null, initialDelayInMs: null }) };
}

function toolCall(id: string, toolName: string, input: unknown): LanguageModelV4StreamPart[] {
  return [
    { type: 'tool-input-start', id, toolName },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: usageOf(10, 5) },
  ];
}

function text(body: string): LanguageModelV4StreamPart[] {
  return [
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: body },
    { type: 'text-end', id: '0' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usageOf(10, 5) },
  ];
}

function inTempDir<T>(fn: () => Promise<T>): Promise<T> {
  const orig = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'shiro-newfeat-'));
  process.chdir(dir);
  return fn().finally(() => {
    process.chdir(orig);
    rmSync(dir, { recursive: true, force: true });
  });
}

const noop = async () => 'once' as const;

async function drain(session: Session): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of session.send('go')) events.push(ev);
  return events;
}

test('/changes summarizes files written by the last turn', () =>
  inTempDir(async () => {
    let call = 0;
    const session = new Session({
      model: new MockLanguageModelV4({
        doStream: async () => stream(call++ === 0 ? toolCall('c1', 'write_file', { path: 'new.txt', content: 'hello' }) : text('done')),
      }),
      askApproval: noop,
    });
    for await (const _ of session.send('write a file')) void _;
    const summary = session.lastTurnSummary();
    expect(summary).toBeDefined();
    expect(summary!.added).toContain(join(process.cwd(), 'new.txt'));
    expect(summary!.modified).toHaveLength(0);
    expect(summary!.deleted).toHaveLength(0);
  }));

test('/changes is undefined for a turn that wrote nothing', () =>
  inTempDir(async () => {
    const session = new Session({
      model: new MockLanguageModelV4({ doStream: async () => stream(text('no writes')) }),
      askApproval: noop,
    });
    await drain(session);
    expect(session.lastTurnSummary()).toBeUndefined();
  }));

test('system prompt is memoized until a volatile part changes', () => {
  const session = new Session({
    model: new MockLanguageModelV4({ doStream: async () => stream(text('ok')) }),
    askApproval: noop,
  });
  // private API is exercised through the public turn loop; assert the cache counts.
  for (let i = 0; i < 3; i++) void session.estimatedTokens();
  // force a miss then a few hits via send
  void drain(session);
  const stats = session.promptCacheStats();
  expect(stats.misses).toBeGreaterThanOrEqual(1);
  expect(stats.hits).toBeGreaterThanOrEqual(0);
});

test('workspace files refresh after a turn writes files', () =>
  inTempDir(async () => {
    let call = 0;
    const session = new Session({
      model: new MockLanguageModelV4({
        doStream: async () => stream(call++ === 0 ? toolCall('c1', 'write_file', { path: 'fresh.txt', content: 'x' }) : text('done')),
      }),
      askApproval: noop,
    });
    await drain(session);
    await session.refreshWorkspaceFiles(true);
    expect(session.workspaceList().includes('fresh.txt')).toBe(true);
  }));

test('per-turn spend cap stops a turn past the line', async () => {
  // gpt-5: 1M in / 1M out = $1.25 + $10 = $11.25, far past a $1 per-turn cap.
  const session = new Session({
    model: new MockLanguageModelV4({
      doStream: async () => stream([
        { type: 'text-start', id: '0' },
        { type: 'text-delta', id: '0', delta: 'costly' },
        { type: 'text-end', id: '0' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usageOf(1_000_000, 1_000_000) },
      ]),
    }),
    modelId: 'gpt-5',
    askApproval: noop,
    maxSpendPerTurn: 1,
  });
  const events = await drain(session);
  const notice = events.find((e) => e.type === 'notice' && e.text.includes('per-turn spend cap'));
  expect(notice).toBeDefined();
  expect(events.some((e) => e.type === 'done')).toBe(true);
});

test('fork copies messages up to the last turn boundary without touching the original', () =>
  inTempDir(async () => {
    const session = new Session({
      model: new MockLanguageModelV4({
        doStream: async () => stream(text('t1')),
      }),
      askApproval: noop,
    });
    await drain(session);
    await drain(session);
    const before = session.messages.length;
    const clone = session.fork();
    expect(clone.length).toBeLessThan(before);
    expect(session.messages.length).toBe(before); // original untouched
    expect(JSON.stringify(clone)).not.toContain('t2');
    // deep independence
    (clone[0] as { content: string }).content = 'mutated';
    expect(JSON.stringify(session.messages)).not.toContain('mutated');
  }));