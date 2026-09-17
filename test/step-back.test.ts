import { usageOf } from './helpers';
import { expect, test } from 'bun:test';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/session';
import { createStepBackTool, type LoopEntry } from '../src/step-back';

const usage = usageOf(10, 5);

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

/** Calls step_back once, then replies. */
function stepBackTurn(): LanguageModelV4StreamPart[] {
  return toolCall('sb', 'step_back', { note: 'grep keeps finding nothing' });
}

test('step_back returns a reflection prompt once there is a trace', async () => {
  const entries: LoopEntry[] = [
    { step: 1, toolName: 'grep', input: '{"pattern":"x"}', result: 'no matches', at: 't1' },
    { step: 2, toolName: 'grep', input: '{"pattern":"y"}', result: 'no matches', at: 't2' },
  ];
  const sb = createStepBackTool({ trace: () => entries });

  const out = await sb.execute!({ note: 'nothing matches' }, { toolCallId: 'c', messages: [] } as never);
  expect(out).toContain('You have run threadbare');
  expect(out).toContain('grep');
  expect(out).toContain('nothing matches');
  expect(out).toContain('ONE different thing');
});

test('step_back on an empty trace says it is too early to help', async () => {
  const sb = createStepBackTool({ trace: () => [] });
  const out = await sb.execute!({}, { toolCallId: 'c', messages: [] } as never);
  expect(out).toContain('No recent steps to reflect on');
});

test('step_back is offered to the model and visible in /tools', () =>
  inTempDir(async () => {
    const session = new Session({
      model: new MockLanguageModelV4({ doStream: async () => stream(text('ok')) }) as never,
      askApproval: async () => 'deny',
    });
    expect(session.activeTools()).toContain('step_back');
  }));

test('a repeated allowed call is escalated and points at step_back', () =>
  inTempDir(async () => {
    await Bun.write(join(process.cwd(), 'a.txt'), 'data');
    // Four identical read_file calls trip the repeat guard (limit 3) on the fourth.
    let call = 0;
    const session = new Session({
      model: new MockLanguageModelV4({
        doStream: async () =>
          stream(call++ < 4 ? toolCall(`c${call}`, 'read_file', { path: 'a.txt' }) : text('done')),
      }) as never,
      askApproval: async () => 'once',
    });

    const notices: string[] = [];
    for await (const ev of session.send('keep reading a.txt')) {
      if (ev.type === 'notice') notices.push(ev.text);
    }
    const guard = notices.find((n) => n.includes('not making progress'));

    // The guard names step_back as the recovery path.
    expect(guard ?? 'no guard notice').toContain('step_back');
  }), 30_000);