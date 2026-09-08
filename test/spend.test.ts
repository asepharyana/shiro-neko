import { usageOf } from './helpers';
import { expect, test } from 'bun:test';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { Session, type AgentEvent } from '../src/session';

function stream(parts: LanguageModelV4StreamPart[]) {
  return { stream: simulateReadableStream({ chunks: parts, chunkDelayInMs: null, initialDelayInMs: null }) };
}

/** A priced model whose single run bills `usage`, so the ceiling arithmetic is exact. */
function modelWith(usage: ReturnType<typeof usageOf>) {
  return new MockLanguageModelV4({
    doStream: async () =>
      stream([
        { type: 'text-start', id: '0' },
        { type: 'text-delta', id: '0', delta: 'ok' },
        { type: 'text-end', id: '0' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
      ]),
  });
}

async function drain(session: Session): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of session.send('go')) events.push(ev);
  return events;
}

const noop = async () => 'once' as const;

test('a session past its ceiling refuses the turn and names the ceiling', async () => {
  // gpt-5 is $1.25/M in, $10/M out. 800k in / 200k out = $1.00 + $2.00 = $3.00.
  const session = new Session({
    model: modelWith(usageOf(800_000, 200_000)),
    modelId: 'gpt-5',
    askApproval: noop,
    maxSpendUsd: 2,
  });

  const first = await drain(session);
  expect(first.some((e) => e.type === 'done')).toBe(true);

  // The first turn put spend over the $2 ceiling; the next is refused before the model runs.
  const second = await drain(session);
  const refusal = second.find((e) => e.type === 'error');
  expect(refusal).toBeDefined();
  expect(refusal!.type === 'error' && String(refusal!.error)).toContain('spend ceiling reached');
  expect(String(refusal!.type === 'error' && refusal!.error)).toContain('$2.00');
});

test('crossing 80% warns once, then stays quiet', async () => {
  // 200k in / 100k out = $0.25 + $1.00 = $1.25, which is 83% of a $1.50 ceiling.
  const session = new Session({
    model: modelWith(usageOf(200_000, 100_000)),
    modelId: 'gpt-5',
    askApproval: noop,
    maxSpendUsd: 1.5,
  });

  const first = await drain(session);
  const warnings = first.filter((e) => e.type === 'notice' && e.text.includes('approaching spend ceiling'));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]!.type === 'notice' && warnings[0]!.text).toContain('$1.50');

  // A second turn at the same level must not repeat the warning.
  const second = await drain(session);
  expect(second.filter((e) => e.type === 'notice' && e.text.includes('approaching spend ceiling'))).toHaveLength(0);
});

test('an unpriced model is never refused, because the ceiling cannot see it', async () => {
  const session = new Session({
    model: modelWith(usageOf(9_000_000, 9_000_000)),
    modelId: 'some-local-model',
    askApproval: noop,
    maxSpendUsd: 0.01,
  });
  const events = await drain(session);
  expect(events.some((e) => e.type === 'done')).toBe(true);
  expect(events.some((e) => e.type === 'error')).toBe(false);
});

test('with no ceiling configured a session spends freely', async () => {
  const session = new Session({ model: modelWith(usageOf(9_000_000, 9_000_000)), modelId: 'gpt-5', askApproval: noop });
  const events = await drain(session);
  expect(events.some((e) => e.type === 'done')).toBe(true);
});

test('spend() reports the ceiling state for the status surface', () => {
  const session = new Session({ model: modelWith(usageOf(1)), modelId: 'gpt-5', askApproval: noop, maxSpendUsd: 4 });
  session.inputTokens = 800_000;
  session.outputTokens = 200_000; // $3.00 of $4.00
  const s = session.spend();
  expect(s.usd).toBeCloseTo(3, 5);
  expect(s.ceiling).toBe(4);
  expect(s.overWarn).toBe(false);
  expect(s.overLimit).toBe(false);
});

test('subagent spend folds into the ceiling and resets with the session', async () => {
  const session = new Session({
    model: modelWith(usageOf(1)),
    modelId: 'gpt-5',
    subagentModelId: 'gpt-5-nano',
    askApproval: noop,
    maxSpendUsd: 4,
  });
  session.recordSubagentUsage({ inputTokens: 1_000_000, outputTokens: 100_000 });
  expect(session.subagentInputTokens).toBe(1_000_000);
  // gpt-5-nano: $0.05/M in, $0.40/M out -> $0.05 + $0.04 = $0.09
  expect(session.spend().usd).toBeCloseTo(0.09, 5);

  session.reset();
  expect(session.subagentInputTokens).toBe(0);
  expect(session.spend().usd).toBeCloseTo(0, 5);
});
