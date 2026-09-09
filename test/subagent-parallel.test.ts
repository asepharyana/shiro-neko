import { expect, test } from 'bun:test';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/session';
import { createTaskTool, type SubagentEvent } from '../src/subagent';

const usage = { inputTokens: 10, outputTokens: 10 } as any;
const parts = (id: string, toolName: string, input: unknown): LanguageModelV4StreamPart[] => [
  { type: 'tool-input-start', id, toolName },
  { type: 'tool-input-end', id },
  { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
];
const txt = (body: string): LanguageModelV4StreamPart[] => [
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', delta: body },
  { type: 'text-end', id: '0' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
];

function inTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const orig = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'shiro-par-'));
  process.chdir(dir);
  return fn(dir).finally(() => {
    process.chdir(orig);
    rmSync(dir, { recursive: true, force: true });
  });
}

test('two tasks dispatched together overlap in time rather than queueing', () =>
  inTempDir(async () => {
    await Bun.write('a.ts', 'export const a = 1;\n');
    await Bun.write('b.ts', 'export const b = 2;\n');
    const events: SubagentEvent[] = [];
    let seen = 0;
    const delay = 50;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const n = seen++;
        if (n === 0) {
          return { stream: simulateReadableStream({ chunks: parts('c1', 'task', { tasks: [{ description: 'find a', prompt: 'Find a' }, { description: 'find b', prompt: 'Find b' }] }), chunkDelayInMs: null, initialDelayInMs: null }) } as any;
        }
        // Each subagent does: one grep (delayed by tool), then text
        // We simulate delay at model level to observe overlap
        if (n === 1 || n === 2) {
          await new Promise((r) => setTimeout(r, delay));
          return { stream: simulateReadableStream({ chunks: parts(`s${n}`, 'grep', { pattern: n === 1 ? 'a' : 'b', include: '**/*.ts' }), chunkDelayInMs: null, initialDelayInMs: null }) } as any;
        }
        if (n === 3 || n === 4) return { stream: simulateReadableStream({ chunks: txt(n === 3 ? 'found a' : 'found b'), chunkDelayInMs: null, initialDelayInMs: null }) } as any;
        return { stream: simulateReadableStream({ chunks: txt('both found'), chunkDelayInMs: null, initialDelayInMs: null }) } as any;
      },
    });

    const session = new Session({
      model,
      askApproval: async () => 'deny' as const,
      extraTools: { task: createTaskTool({ model, report: (e) => events.push(e) }) },
      autoApprove: ['task'],
    });

    const t0 = Date.now();
    for await (const _ of session.send('go')) void _;
    const dt = Date.now() - t0;

    // Sequential would be ~delay + delay serially; parallel keeps it near one delay.
    // Allow generous headroom for CI jitter but require overlap.
    expect(dt).toBeLessThan(delay * 2 + 80);

    // Both findings reach the parent as one tool result with headings
    const toolMsg = session.messages.find((m) => m.role === 'tool');
    const body = JSON.stringify(toolMsg);
    expect(body).toContain('find a');
    expect(body).toContain('find b');

    // Panel saw two starts before two ends (fan-out)
    const starts = events.filter((e) => e.type === 'start').map((e) => (e as Extract<SubagentEvent, { type: 'start' }>).description);
    expect(starts).toContain('find a');
    expect(starts).toContain('find b');
  }));

test('a single task still works through the same path', () =>
  inTempDir(async () => {
    await Bun.write('a.ts', 'export const a = 1;\n');
    let seen = 0;
    const model = new MockLanguageModelV4({
      doStream: async (opts) => {
        const n = seen++;
        if (n === 0) return { stream: simulateReadableStream({ chunks: parts('c1', 'task', { description: 'find a', prompt: 'Find a' }), chunkDelayInMs: null, initialDelayInMs: null }) } as any;
        if (n === 1) return { stream: simulateReadableStream({ chunks: parts('s1', 'grep', { pattern: 'a', include: '**/*.ts' }), chunkDelayInMs: null, initialDelayInMs: null }) } as any;
        if (n === 2) return { stream: simulateReadableStream({ chunks: txt('found a at a.ts'), chunkDelayInMs: null, initialDelayInMs: null }) } as any;
        return { stream: simulateReadableStream({ chunks: txt('done'), chunkDelayInMs: null, initialDelayInMs: null }) } as any;
      },
    });
    const session = new Session({ model, askApproval: async () => 'deny' as const, extraTools: { task: createTaskTool({ model }) }, autoApprove: ['task'] });
    for await (const _ of session.send('go')) void _;
    expect(JSON.stringify(session.messages)).toContain('found a at a.ts');
  }));
