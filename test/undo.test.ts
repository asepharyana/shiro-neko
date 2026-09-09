import { expect, test } from 'bun:test';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/session';

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } } as unknown as import('@ai-sdk/provider').LanguageModelV4Usage;

function stream(parts: LanguageModelV4StreamPart[]) {
  return { stream: simulateReadableStream({ chunks: parts, chunkDelayInMs: null, initialDelayInMs: null }) };
}
function toolCall(id: string, toolName: string, input: unknown): LanguageModelV4StreamPart[] {
  return [
    { type: 'tool-input-start', id, toolName },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
  ];
}
function text(body: string): LanguageModelV4StreamPart[] {
  return [
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: body },
    { type: 'text-end', id: '0' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
  ];
}
function inTempDir<T>(fn: () => Promise<T>): Promise<T> {
  const orig = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'shiro-undo-'));
  process.chdir(dir);
  return fn().finally(() => {
    process.chdir(orig);
    rmSync(dir, { recursive: true, force: true });
  });
}

test('undo restores file and removes the turn messages', async () =>
  inTempDir(async () => {
    const p = join(process.cwd(), 'note.txt');
    await Bun.write(p, 'before\n');
    let call = 0;
    const session = new Session({
      yolo: true,
      model: new MockLanguageModelV4({
        doStream: async () => stream(call++ === 0 ? toolCall('c1', 'write_file', { path: 'note.txt', content: 'after\n' }) : text('done')),
      }),
      askApproval: async () => 'once',
    });
    for await (const _ of session.send('overwrite note')) void _;
    expect(await Bun.file(p).text()).toBe('after\n');
    const lenAfter = session.messages.length;
    const msg = await session.undo();
    expect(msg).toMatch(/undone/);
    expect(await Bun.file(p).text()).toBe('before\n');
    expect(session.messages.length).toBeLessThan(lenAfter);
  }));

test('redo restores file and messages after undo', async () =>
  inTempDir(async () => {
    const p = join(process.cwd(), 'note.txt');
    await Bun.write(p, 'before\n');
    let call = 0;
    const session = new Session({
      yolo: true,
      model: new MockLanguageModelV4({
        doStream: async () => stream(call++ === 0 ? toolCall('c1', 'write_file', { path: 'note.txt', content: 'after\n' }) : text('done')),
      }),
      askApproval: async () => 'once',
    });
    for await (const _ of session.send('overwrite')) void _;
    const lenAfter = session.messages.length;
    await session.undo();
    expect(await Bun.file(p).text()).toBe('before\n');
    const msg = await session.redo();
    expect(msg).toMatch(/redone/);
    expect(await Bun.file(p).text()).toBe('after\n');
    expect(session.messages.length).toBe(lenAfter);
  }));

test('bash effects are not snapshotted (file left, messages still undone)', async () =>
  inTempDir(async () => {
    const p = join(process.cwd(), 'out.txt');
    let call = 0;
    const session = new Session({
      yolo: true,
      model: new MockLanguageModelV4({
        doStream: async () => stream(call++ === 0 ? toolCall('c1', 'bash', { command: 'echo hi > out.txt' }) : text('done')),
      }),
      askApproval: async () => 'once',
    });
    for await (const _ of session.send('make file via bash')) void _;
    expect(await Bun.file(p).exists()).toBe(true);
    const lenAfter = session.messages.length;
    const msg = await session.undo();
    expect(msg).toMatch(/bash effects.*not snapshotted/);
    // bash file remains (not part of snapshot)
    expect(await Bun.file(p).exists()).toBe(true);
    // but messages are still rewound
    expect(session.messages.length).toBeLessThan(lenAfter);
  }));

test('cap 100: oldest snapshot drops', async () => {
  const { SnapshotStack } = await import('../src/snapshot');
  const s = new SnapshotStack();
  for (let i = 0; i < 105; i++) {
    s.push({ beforeLen: i, afterLen: i + 1, beforeFiles: new Map(), afterFiles: new Map() });
  }
  expect(s.depth().undo).toBe(100);
});
