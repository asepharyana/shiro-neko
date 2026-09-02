import { expect, test } from 'bun:test';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { tool } from 'ai';
import { z } from 'zod';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/session';
import { interruptBash } from '../src/tools';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, total_text: 5 },
} as any;

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
  const dir = mkdtempSync(join(tmpdir(), 'shiro-loop-'));
  process.chdir(dir);
  return fn().finally(() => {
    process.chdir(orig);
    rmSync(dir, { recursive: true, force: true });
  });
}

test('read-only tool runs without approval and the loop terminates', async () =>
  inTempDir(async () => {
    await Bun.write(join(process.cwd(), 'note.txt'), 'hello');

    let call = 0;
    const session = new Session({
      model: new MockLanguageModelV4({
        doStream: async () => stream(call++ === 0 ? toolCall('c1', 'read_file', { path: 'note.txt' }) : text('done')),
      }),
      askApproval: async () => {
        throw new Error('read_file must not require approval');
      },
    });

    const kinds: string[] = [];
    for await (const ev of session.send('read note.txt')) kinds.push(ev.type);

    expect(kinds).toEqual(['tool-start', 'tool-call', 'tool-result', 'text', 'done']);
    expect(call).toBe(2);
  }));

test('approved edit_file mutates the file after the user allows it', async () =>
  inTempDir(async () => {
    const path = join(process.cwd(), 'app.ts');
    await Bun.write(path, 'const a = 1;\n');

    let call = 0;
    const asked: string[] = [];
    const session = new Session({
      model: new MockLanguageModelV4({
        doStream: async () =>
          stream(
            call++ === 0
              ? toolCall('c1', 'edit_file', { path: 'app.ts', oldString: 'const a = 1;', newString: 'const a = 2;' })
              : text('edited'),
          ),
      }),
      askApproval: async (req) => {
        asked.push(req.toolName);
        return 'once';
      },
    });

    for await (const _ of session.send('bump a')) void _;

    expect(asked).toEqual(['edit_file']);
    expect(await Bun.file(path).text()).toBe('const a = 2;\n');
  }));

test('denied bash leaves the workspace untouched and tells the model', async () =>
  inTempDir(async () => {
    let call = 0;
    const session = new Session({
      model: new MockLanguageModelV4({
        doStream: async () =>
          stream(call++ === 0 ? toolCall('c1', 'bash', { command: 'echo pwned > pwned.txt' }) : text('understood')),
      }),
      askApproval: async () => 'deny',
    });

    const kinds: string[] = [];
    for await (const ev of session.send('run it')) kinds.push(ev.type);

    expect(kinds).toContain('tool-denied');
    expect(await Bun.file(join(process.cwd(), 'pwned.txt')).exists()).toBe(false);
    expect(session.messages.some((m) => m.role === 'tool')).toBe(true);
  }));

test('"always" approval is asked once and reused for later calls of the same tool', async () =>
  inTempDir(async () => {
    let call = 0;
    let asks = 0;
    const session = new Session({
      model: new MockLanguageModelV4({
        doStream: async () => {
          const n = call++;
          if (n === 0) return stream(toolCall('c1', 'write_file', { path: 'a.txt', content: 'a' }));
          if (n === 1) return stream(toolCall('c2', 'write_file', { path: 'b.txt', content: 'b' }));
          return stream(text('both written'));
        },
      }),
      askApproval: async () => {
        asks++;
        return 'always';
      },
    });

    for await (const _ of session.send('write two files')) void _;

    expect(asks).toBe(1);
    expect(await Bun.file(join(process.cwd(), 'b.txt')).text()).toBe('b');
  }));

test('yolo mode never asks for approval', async () =>
  inTempDir(async () => {
    let call = 0;
    const session = new Session({
      yolo: true,
      model: new MockLanguageModelV4({
        doStream: async () =>
          stream(call++ === 0 ? toolCall('c1', 'write_file', { path: 'y.txt', content: 'y' }) : text('ok')),
      }),
      askApproval: async () => {
        throw new Error('yolo must not ask');
      },
    });

    for await (const _ of session.send('write y')) void _;
    expect(await Bun.file(join(process.cwd(), 'y.txt')).text()).toBe('y');
  }));

const mcpTool = (calls: string[]) =>
  tool({
    description: 'stand-in for a tool supplied by an MCP server',
    inputSchema: z.object({ note: z.string() }),
    execute: async ({ note }) => {
      calls.push(note);
      return `pong: ${note}`;
    },
  });

test('an mcp tool reaches the model alongside the built-ins', async () => {
  const seen: LanguageModelV4CallOptions[] = [];
  const session = new Session({
    model: new MockLanguageModelV4({
      doStream: async (o) => {
        seen.push(o);
        return stream(text('ok'));
      },
    }),
    askApproval: async () => 'deny',
    extraTools: { mcp__stub__ping: mcpTool([]) },
  });

  for await (const _ of session.send('hi')) void _;

  const names = (seen[0]?.tools ?? []).map((t) => t.name).sort();
  expect(names).toContain('mcp__stub__ping');
  expect(names).toContain('read_file');
  expect(Object.keys(session.tools)).toContain('mcp__stub__ping');
});

test('an mcp tool is gated behind approval even though it is not a built-in', async () => {
  const asked: string[] = [];
  const executed: string[] = [];
  let call = 0;
  const session = new Session({
    model: new MockLanguageModelV4({
      doStream: async () =>
        stream(call++ === 0 ? toolCall('c1', 'mcp__stub__ping', { note: 'hello' }) : text('done')),
    }),
    askApproval: async (req) => {
      asked.push(req.toolName);
      return 'once';
    },
    extraTools: { mcp__stub__ping: mcpTool(executed) },
  });

  for await (const _ of session.send('ping the server')) void _;

  expect(asked).toEqual(['mcp__stub__ping']);
  expect(executed).toEqual(['hello']);
});

test('a denied mcp tool never executes', async () => {
  const executed: string[] = [];
  let call = 0;
  const session = new Session({
    model: new MockLanguageModelV4({
      doStream: async () =>
        stream(call++ === 0 ? toolCall('c1', 'mcp__stub__ping', { note: 'nope' }) : text('understood')),
    }),
    askApproval: async () => 'deny',
    extraTools: { mcp__stub__ping: mcpTool(executed) },
  });

  const kinds: string[] = [];
  for await (const ev of session.send('ping')) kinds.push(ev.type);

  expect(kinds).toContain('tool-denied');
  expect(executed).toEqual([]);
});

test('an auto-approved extra tool runs unattended', async () => {
  const executed: string[] = [];
  let call = 0;
  const session = new Session({
    model: new MockLanguageModelV4({
      doStream: async () =>
        stream(call++ === 0 ? toolCall('c1', 'mcp__stub__ping', { note: 'auto' }) : text('done')),
    }),
    askApproval: async () => {
      throw new Error('an auto-approved tool must not prompt');
    },
    extraTools: { mcp__stub__ping: mcpTool(executed) },
    autoApprove: ['mcp__stub__ping'],
  });

  for await (const _ of session.send('ping')) void _;
  expect(executed).toEqual(['auto']);
});

test('a read-only built-in stays free even when mcp tools are present', async () =>
  inTempDir(async () => {
    await Bun.write(join(process.cwd(), 'note.txt'), 'hello');
    let call = 0;
    const session = new Session({
      model: new MockLanguageModelV4({
        doStream: async () =>
          stream(call++ === 0 ? toolCall('c1', 'read_file', { path: 'note.txt' }) : text('read it')),
      }),
      askApproval: async () => {
        throw new Error('read_file must not require approval');
      },
      extraTools: { mcp__stub__ping: mcpTool([]) },
    });

    const kinds: string[] = [];
    for await (const ev of session.send('read note.txt')) kinds.push(ev.type);
    expect(kinds).toEqual(['tool-start', 'tool-call', 'tool-result', 'text', 'done']);
  }));

test('setModel swaps the model used by the next turn', async () => {
  const first = new MockLanguageModelV4({ modelId: 'first', doStream: async () => stream(text('from first')) });
  const second = new MockLanguageModelV4({ modelId: 'second', doStream: async () => stream(text('from second')) });

  const session = new Session({ model: first, askApproval: async () => 'deny' });

  let out = '';
  for await (const ev of session.send('a')) if (ev.type === 'text') out += ev.text;
  expect(out).toBe('from first');

  session.setModel(second);
  out = '';
  for await (const ev of session.send('b')) if (ev.type === 'text') out += ev.text;
  expect(out).toBe('from second');
});

test('reset clears history and token counters; replace swaps history in', async () => {
  const session = new Session({
    model: new MockLanguageModelV4({ doStream: async () => stream(text('ok')) }),
    askApproval: async () => 'deny',
  });

  for await (const _ of session.send('hello')) void _;
  expect(session.messages.length).toBe(2);
  expect(session.inputTokens).toBe(10);

  session.reset();
  expect(session.messages).toEqual([]);
  expect(session.inputTokens).toBe(0);
  expect(session.outputTokens).toBe(0);

  session.replace([{ role: 'user', content: 'restored' }]);
  expect(session.messages).toEqual([{ role: 'user', content: 'restored' }]);
});

test('abort mid-stream ends the turn with done, keeping the text already delivered', async () => {  const session = new Session({
    model: new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: '0' },
            { type: 'text-delta', id: '0', delta: 'partial' },
            { type: 'text-delta', id: '0', delta: 'never arrives' },
            { type: 'text-end', id: '0' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
          ] as LanguageModelV4StreamPart[],
          initialDelayInMs: null,
          chunkDelayInMs: 200,
        }),
      }),
    }),
    askApproval: async () => 'deny',
  });

  const kinds: string[] = [];
  let delivered = '';
  const turn = (async () => {
    for await (const ev of session.send('slow')) {
      kinds.push(ev.type);
      if (ev.type === 'text') delivered += ev.text;
    }
  })();
  await Bun.sleep(300);
  session.abort();
  await turn;

  expect(delivered).toBe('partial');
  expect(kinds.at(-1)).toBe('done');
  expect(kinds).not.toContain('error');
}, 15_000);

test('an interrupted command becomes a tool error and the turn carries on', async () =>
  inTempDir(async () => {
    const sleeper = process.platform === 'win32' ? 'ping -n 20 127.0.0.1 > nul' : 'sleep 20';
    let call = 0;
    const session = new Session({
      yolo: true,
      model: new MockLanguageModelV4({
        doStream: async () =>
          stream(call++ === 0 ? toolCall('c1', 'bash', { command: sleeper }) : text('I stopped there.')),
      }),
      askApproval: async () => {
        throw new Error('yolo must not ask');
      },
    });

    const kinds: string[] = [];
    let toolError = '';
    const turn = (async () => {
      for await (const ev of session.send('run the long thing')) {
        kinds.push(ev.type);
        if (ev.type === 'tool-error') toolError = String((ev.error as Error).message ?? ev.error);
      }
    })();

    // Interrupt once the command is actually running.
    await Bun.sleep(700);
    expect(interruptBash()).toEqual([sleeper]);
    await turn;

    expect(kinds).toContain('tool-error');
    expect(toolError).toMatch(/user interrupted this command/i);
    // The turn survived: the model was asked again and its reply arrived.
    expect(kinds).toContain('text');
    expect(kinds.at(-1)).toBe('done');
    expect(call).toBe(2);
  }), 30_000);
