import { expect, test } from 'bun:test';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHeadless } from '../src/headless';
import { Session } from '../src/session';

const usage = {
  inputTokens: { total: 9, noCache: 9, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 4 },
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
  const dir = mkdtempSync(join(tmpdir(), 'shiro-head-'));
  process.chdir(dir);
  return fn(dir).finally(() => {
    process.chdir(orig);
    rmSync(dir, { recursive: true, force: true });
  });
}

test('text mode writes only assistant text to stdout and exits 0', async () => {
  let out = '';
  const session = new Session({
    model: new MockLanguageModelV4({ doStream: async () => stream(text('42')) }),
    askApproval: async () => 'deny',
  });

  const code = await runHeadless({ session, prompt: 'what is 6*7', out: (s) => (out += s) });

  expect(code).toBe(0);
  expect(out).toBe('42\n');
});

test('json mode emits one parseable event per line', async () => {
  let out = '';
  const session = new Session({
    model: new MockLanguageModelV4({ doStream: async () => stream(text('hi')) }),
    askApproval: async () => 'deny',
  });

  await runHeadless({ session, prompt: 'hello', format: 'json', out: (s) => (out += s) });

  const events = out.trim().split('\n').map((l) => JSON.parse(l));
  expect(events.map((e) => e.type)).toEqual(['text', 'done']);
  expect(events.at(-1)).toMatchObject({ inputTokens: 9, outputTokens: 4 });
});

test('json mode flattens an Error into a readable message', async () => {
  let out = '';
  const session = new Session({
    model: new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('upstream is on fire');
      },
    }),
    askApproval: async () => 'deny',
  });

  await runHeadless({ session, prompt: 'go', format: 'json', out: (s) => (out += s) });

  const events = out.trim().split('\n').map((l) => JSON.parse(l) as { type: string; error?: unknown });
  const failure = events.find((e) => e.type === 'error');
  expect(failure?.error).toContain('upstream is on fire');
});

test('json mode flattens a tool error too', async () =>
  inTempDir(async () => {
    let out = '';
    let n = 0;
    const session = new Session({
      yolo: true,
      model: new MockLanguageModelV4({
        doStream: async () =>
          n++ === 0 ? stream(toolCall('c1', 'read_file', { path: 'missing.txt' })) : stream(text('could not read it')),
      }),
      askApproval: async () => 'deny',
    });

    await runHeadless({ session, prompt: 'read it', format: 'json', out: (s) => (out += s) });

    const events = out.trim().split('\n').map((l) => JSON.parse(l) as { type: string; error?: unknown });
    const failure = events.find((e) => e.type === 'tool-error');
    expect(String(failure?.error)).toContain('No such file');
  }));

test('a model error sets exit code 1', async () => {
  const session = new Session({
    model: new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('upstream exploded');
      },
    }),
    askApproval: async () => 'deny',
  });

  const code = await runHeadless({ session, prompt: 'go', out: () => {} });
  expect(code).toBe(1);
});

test('without yolo a mutating tool is denied and the workspace is untouched', async () =>
  inTempDir(async (dir) => {
    let n = 0;
    const session = new Session({
      model: new MockLanguageModelV4({
        doStream: async () =>
          n++ === 0
            ? stream(toolCall('c1', 'write_file', { path: 'pwned.txt', content: 'x' }))
            : stream(text('I was not allowed to write.')),
      }),
      askApproval: async () => 'deny',
    });

    let out = '';
    const code = await runHeadless({ session, prompt: 'write a file', format: 'json', out: (s) => (out += s) });

    expect(code).toBe(0);
    expect(out).toContain('"tool-denied"');
    expect(await Bun.file(join(dir, 'pwned.txt')).exists()).toBe(false);
  }));

test('with yolo the tool runs unattended', async () =>
  inTempDir(async (dir) => {
    let n = 0;
    const session = new Session({
      yolo: true,
      model: new MockLanguageModelV4({
        doStream: async () =>
          n++ === 0 ? stream(toolCall('c1', 'write_file', { path: 'ok.txt', content: 'yes' })) : stream(text('written')),
      }),
      askApproval: async () => {
        throw new Error('yolo must not prompt');
      },
    });

    const code = await runHeadless({ session, prompt: 'write ok.txt', out: () => {} });

    expect(code).toBe(0);
    expect(await Bun.file(join(dir, 'ok.txt')).text()).toBe('yes');
  }));
