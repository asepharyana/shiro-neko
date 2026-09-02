import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/session';
import { App, createApprovalBridge } from '../src/ui/App';
import { testHooks } from './helpers';

const usage = {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7 },
} as any;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('approval prompt renders and a keypress lets the tool through', async () => {
  const orig = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'shiro-ui-'));
  process.chdir(dir);

  try {
    let n = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const chunks: any[] =
          n++ === 0
            ? [
                { type: 'tool-input-start', id: 'c1', toolName: 'write_file' },
                { type: 'tool-input-end', id: 'c1' },
                {
                  type: 'tool-call',
                  toolCallId: 'c1',
                  toolName: 'write_file',
                  input: JSON.stringify({ path: 'out.txt', content: 'hello' }),
                },
                { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
              ]
            : [
                { type: 'text-start', id: '0' },
                { type: 'text-delta', id: '0', delta: 'Wrote out.txt.' },
                { type: 'text-end', id: '0' },
                { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
              ];
        return { stream: simulateReadableStream({ chunks, chunkDelayInMs: null, initialDelayInMs: null }) };
      },
    });

    const bridge = createApprovalBridge();
    const session = new Session({ model, askApproval: bridge.ask });
    const app = render(
      <App
        session={session}
        bridge={bridge}
        header="shiro-neko  mock/mock"
        hooks={testHooks({ config: () => ({ provider: 'openai', model: 'mock' }) })}
      />,
    );

    await wait(150);
    expect(app.lastFrame()).toContain('shiro-neko  mock/mock');

    app.stdin.write('write a file');
    await wait(80);
    app.stdin.write('\r');
    await wait(400);

    const prompt = app.lastFrame() ?? '';
    expect(prompt).toContain('write_file wants to run');
    expect(prompt).toContain('allow once');
    expect(await Bun.file(join(dir, 'out.txt')).exists()).toBe(false);

    app.stdin.write('y');
    await wait(500);

    expect(await Bun.file(join(dir, 'out.txt')).text()).toBe('hello');
    expect(app.lastFrame()).toContain('12 in / 7 out tokens');

    app.unmount();
  } finally {
    process.chdir(orig);
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);
