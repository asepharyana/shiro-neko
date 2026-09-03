import { expect, test } from 'bun:test';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '../src/plugins';
import { guardPlugin } from '../src/plugins-builtin';
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

    expect(events).toEqual(['tool-start', 'tool-call', 'tool-result', 'text', 'done']);

    // An explore subagent holds no mutating tool, so it cannot reach the approval
    // gate at all. That is structural rather than policy.
    const subagentTools = (seen[1]?.tools ?? []).map((t) => t.name);
    for (const write of ['write_file', 'edit_file', 'multi_edit', 'bash']) {
      expect(subagentTools).not.toContain(write);
    }
    expect(subagentTools).toContain('grep');

    // Its findings reach the parent as a tool result, not as raw transcript.
    const toolMessage = session.messages.find((m) => m.role === 'tool');
    expect(JSON.stringify(toolMessage)).toContain('src/auth.ts:1');
  }));

test('a worker subagent edits a file, and the write goes through the parent gate', async () =>
  inTempDir(async () => {
    await Bun.write('app.ts', 'const port = 8080;\n');

    const asked: { toolName: string; subagent?: boolean }[] = [];
    const seen: LanguageModelV4CallOptions[] = [];
    const model = new MockLanguageModelV4({
      doStream: async (opts) => {
        const call = seen.length;
        seen.push(opts);
        if (call === 0) {
          return stream(
            toolCall('c1', 'task', { description: 'bump the port', prompt: 'Set port to 9090 in app.ts.', kind: 'worker' }),
          );
        }
        if (call === 1) {
          return stream(
            toolCall('s1', 'edit_file', { path: 'app.ts', oldString: 'const port = 8080;', newString: 'const port = 9090;' }),
          );
        }
        if (call === 2) return stream(text('Changed app.ts: port is now 9090.'));
        return stream(text('The worker bumped the port.'));
      },
    });

    const session: Session = new Session({
      model,
      askApproval: async (req) => {
        asked.push({ toolName: req.toolName, ...(req.subagent ? { subagent: true } : {}) });
        return 'once';
      },
      extraTools: {
        task: createTaskTool({ model, approve: (r) => session.approveForSubagent()(r) }),
      },
      autoApprove: ['task'],
    });

    for await (const _ of session.send('bump the port')) void _;

    // The write reached the user's prompt, flagged as coming from a subagent, and
    // the file on disk actually changed.
    expect(asked).toEqual([{ toolName: 'edit_file', subagent: true }]);
    expect(await Bun.file('app.ts').text()).toBe('const port = 9090;\n');
  }));

test('a denied worker write leaves the file alone and the worker reports it', async () =>
  inTempDir(async () => {
    await Bun.write('app.ts', 'const port = 8080;\n');

    const seen: LanguageModelV4CallOptions[] = [];
    const model = new MockLanguageModelV4({
      doStream: async (opts) => {
        const call = seen.length;
        seen.push(opts);
        if (call === 0) {
          return stream(toolCall('c1', 'task', { description: 'bump it', prompt: 'set 9090', kind: 'worker' }));
        }
        if (call === 1) {
          return stream(
            toolCall('s1', 'edit_file', { path: 'app.ts', oldString: 'const port = 8080;', newString: 'const port = 9090;' }),
          );
        }
        if (call === 2) return stream(text('The user denied the edit, so I stopped.'));
        return stream(text('The worker was denied.'));
      },
    });

    const session: Session = new Session({
      model,
      askApproval: async () => 'deny',
      extraTools: {
        task: createTaskTool({ model, approve: (r) => session.approveForSubagent()(r) }),
      },
      autoApprove: ['task'],
    });

    for await (const _ of session.send('bump the port')) void _;

    expect(await Bun.file('app.ts').text()).toBe('const port = 8080;\n');
    expect(JSON.stringify(session.messages)).toContain('denied');
  }));

test('a permission rule denies a worker write without ever prompting', async () =>
  inTempDir(async () => {
    await Bun.write('app.ts', 'const port = 8080;\n');

    const seen: LanguageModelV4CallOptions[] = [];
    const model = new MockLanguageModelV4({
      doStream: async (opts) => {
        const call = seen.length;
        seen.push(opts);
        if (call === 0) {
          return stream(toolCall('c1', 'task', { description: 'bump it', prompt: 'set 9090', kind: 'worker' }));
        }
        if (call === 1) {
          return stream(
            toolCall('s1', 'edit_file', { path: 'app.ts', oldString: 'const port = 8080;', newString: 'const port = 9090;' }),
          );
        }
        if (call === 2) return stream(text('That edit was refused.'));
        return stream(text('Refused.'));
      },
    });

    const session: Session = new Session({
      model,
      askApproval: async () => {
        throw new Error('a rule that denies must not reach the prompt');
      },
      permissions: { edit_file: { '*': 'deny' } },
      extraTools: {
        task: createTaskTool({ model, approve: (r) => session.approveForSubagent()(r) }),
      },
      autoApprove: ['task'],
    });

    for await (const _ of session.send('bump the port')) void _;
    expect(await Bun.file('app.ts').text()).toBe('const port = 8080;\n');
  }));

test('the guard plugin refuses a worker command, as it does a direct one', async () =>
  inTempDir(async () => {
    const seen: LanguageModelV4CallOptions[] = [];
    const model = new MockLanguageModelV4({
      doStream: async (opts) => {
        const call = seen.length;
        seen.push(opts);
        if (call === 0) {
          return stream(toolCall('c1', 'task', { description: 'clean', prompt: 'clean the tree', kind: 'worker' }));
        }
        if (call === 1) return stream(toolCall('s1', 'bash', { command: 'rm -rf build' }));
        if (call === 2) return stream(text('That command was refused.'));
        return stream(text('Refused.'));
      },
    });

    const session: Session = new Session({
      yolo: true,
      model,
      askApproval: async () => {
        throw new Error('the guard must refuse without asking');
      },
      plugins: createHost([guardPlugin]),
      extraTools: {
        task: createTaskTool({ model, approve: (r) => session.approveForSubagent()(r) }),
      },
      autoApprove: ['task'],
    });

    for await (const _ of session.send('clean up')) void _;
    expect(await Bun.file('build').exists()).toBe(false);
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
