import { expect, test } from 'bun:test';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/session';
import { createTaskTool } from '../src/subagent';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5 },
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

function inTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const orig = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'shiro-sub-'));
  process.chdir(dir);
  return fn(dir).finally(() => {
    process.chdir(orig);
    rmSync(dir, { recursive: true, force: true });
  });
}

test('subagent greps the workspace and returns text to the parent', async () =>
  inTempDir(async () => {
    await Bun.write('src/auth.ts', 'export function login() {}\n');

    // Two independent loops share this model: the parent, then the subagent.
    const seen: LanguageModelV4CallOptions[] = [];
    const model = new MockLanguageModelV4({
      doStream: async (opts) => {
        const call = seen.length;
        seen.push(opts);
        if (call === 0) {
          return stream(
            toolCall('c1', 'task', { description: 'find auth', prompt: 'Find where login is defined under src/.' }),
          );
        }
        if (call === 1) return stream(toolCall('s1', 'grep', { pattern: 'login', include: '**/*.ts' }));
        if (call === 2) return stream(text('login() is defined at src/auth.ts:1'));
        return stream(text('The subagent found it in src/auth.ts.'));
      },
    });

    const session = new Session({
      model,
      askApproval: async () => {
        throw new Error('the task tool must never require approval');
      },
      extraTools: { task: createTaskTool({ model }) },
      autoApprove: ['task'],
    });

    const events: string[] = [];
    for await (const ev of session.send('where is login defined?')) events.push(ev.type);

    expect(events).toEqual(['tool-call', 'tool-result', 'text', 'done']);

    // The subagent gets only read tools, so it can never trigger an approval prompt.
    const subagentTools = (seen[1]?.tools ?? []).map((t) => t.name).sort();
    expect(subagentTools).toEqual(['glob', 'grep', 'read_file']);

    // Its findings reach the parent as a tool result, not as raw transcript.
    const toolMessage = session.messages.find((m) => m.role === 'tool');
    expect(JSON.stringify(toolMessage)).toContain('src/auth.ts:1');
  }));

test('subagent does not see the parent conversation', async () =>
  inTempDir(async () => {
    const seen: LanguageModelV4CallOptions[] = [];
    const model = new MockLanguageModelV4({
      doStream: async (opts) => {
        const call = seen.length;
        seen.push(opts);
        if (call === 0) return stream(toolCall('c1', 'task', { description: 'probe', prompt: 'Look at glob src/*.' }));
        if (call === 1) return stream(text('nothing notable'));
        return stream(text('done'));
      },
    });

    const session = new Session({
      model,
      askApproval: async () => 'deny',
      extraTools: { task: createTaskTool({ model }) },
      autoApprove: ['task'],
    });

    for await (const _ of session.send('MY-SECRET-PARENT-CONTEXT')) void _;

    expect(JSON.stringify(seen[1]?.prompt)).not.toContain('MY-SECRET-PARENT-CONTEXT');
    expect(JSON.stringify(seen[1]?.prompt)).toContain('Look at glob src/*.');
  }));
