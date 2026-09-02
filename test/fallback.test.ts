import { expect, test } from 'bun:test';
import { APICallError } from 'ai';
import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { simulateReadableStream } from 'ai/test';
import { withFallback, type FallbackEvent } from '../src/fallback';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1 },
} as any;

const okStream = (body: string) => ({
  stream: simulateReadableStream<LanguageModelV4StreamPart>({
    chunks: [
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', delta: body },
      { type: 'text-end', id: '0' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
    ],
    chunkDelayInMs: null,
    initialDelayInMs: null,
  }),
});

const apiError = (statusCode: number, message: string, isRetryable = false) =>
  new APICallError({ message, url: 'http://x/v1', requestBodyValues: {}, statusCode, isRetryable });

function model(name: string, behaviour: () => Promise<any>): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: name,
    supportedUrls: {},
    doGenerate: behaviour,
    doStream: behaviour,
  };
}

const opts = { prompt: [] } as any;

const REAL_MESSAGE =
  "Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";

test('a single model is returned unwrapped', async () => {
  const only = model('solo', async () => okStream('hi'));
  expect(withFallback([only])).toBe(only);
});

test('withFallback with no models is a programming error', () => {
  expect(() => withFallback([])).toThrow(/needs at least one model/);
});

test('the primary is used when it works and no fallback is reported', async () => {
  const events: FallbackEvent[] = [];
  let secondCalls = 0;
  const wrapped = withFallback(
    [
      model('chat', async () => okStream('from chat')),
      model('responses', async () => {
        secondCalls++;
        return okStream('from responses');
      }),
    ],
    (e) => events.push(e),
  );

  await wrapped.doStream(opts);
  expect(secondCalls).toBe(0);
  expect(events).toEqual([]);
});

test('the real gpt-5.6 400 falls through to the second endpoint', async () => {
  const events: FallbackEvent[] = [];
  const wrapped = withFallback(
    [
      model('chat', async () => {
        throw apiError(400, REAL_MESSAGE);
      }),
      model('responses', async () => okStream('worked on responses')),
    ],
    (e) => events.push(e),
  );

  const result = await wrapped.doStream(opts);
  expect(result.stream).toBeDefined();
  expect(events).toHaveLength(1);
  expect(events[0]?.from).toBe('test/chat');
  expect(events[0]?.to).toBe('test/responses');
  expect(events[0]?.reason).toContain('400');
  expect(events[0]?.reason).toContain('/v1/responses');
});

test('doGenerate falls back on the same condition as doStream', async () => {
  const wrapped = withFallback([
    model('chat', async () => {
      throw apiError(400, REAL_MESSAGE);
    }),
    model('responses', async () => ({ content: [{ type: 'text', text: 'ok' }] })),
  ]);

  const out = (await wrapped.doGenerate(opts)) as any;
  expect(out.content[0].text).toBe('ok');
});

test('a 401 is not a shape mismatch, so it propagates untouched', async () => {
  let secondCalls = 0;
  const wrapped = withFallback([
    model('chat', async () => {
      throw apiError(401, 'invalid api key');
    }),
    model('responses', async () => {
      secondCalls++;
      return okStream('should not happen');
    }),
  ]);

  expect(wrapped.doStream(opts)).rejects.toThrow(/invalid api key/);
  await Bun.sleep(5);
  expect(secondCalls).toBe(0);
});

test('a retryable 500 is left to the SDK retry, not the fallback chain', async () => {
  let secondCalls = 0;
  const wrapped = withFallback([
    model('chat', async () => {
      throw apiError(500, 'upstream down', true);
    }),
    model('responses', async () => {
      secondCalls++;
      return okStream('nope');
    }),
  ]);

  expect(wrapped.doStream(opts)).rejects.toThrow(/upstream down/);
  await Bun.sleep(5);
  expect(secondCalls).toBe(0);
});

test('a non-API error propagates without switching endpoints', async () => {
  let secondCalls = 0;
  const wrapped = withFallback([
    model('chat', async () => {
      throw new TypeError('bug in our code');
    }),
    model('responses', async () => {
      secondCalls++;
      return okStream('nope');
    }),
  ]);

  expect(wrapped.doStream(opts)).rejects.toThrow(/bug in our code/);
  await Bun.sleep(5);
  expect(secondCalls).toBe(0);
});

test('when every endpoint rejects the shape, the last error surfaces', async () => {
  const events: FallbackEvent[] = [];
  const wrapped = withFallback(
    [
      model('a', async () => {
        throw apiError(400, 'a rejected');
      }),
      model('b', async () => {
        throw apiError(404, 'b has no such route');
      }),
    ],
    (e) => events.push(e),
  );

  expect(wrapped.doStream(opts)).rejects.toThrow(/b has no such route/);
  await Bun.sleep(5);
  expect(events).toHaveLength(1);
});

test('the switch is sticky: the rejecting endpoint is not probed again', async () => {
  let chatCalls = 0;
  let respCalls = 0;
  const events: FallbackEvent[] = [];
  const wrapped = withFallback(
    [
      model('chat', async () => {
        chatCalls++;
        throw apiError(400, REAL_MESSAGE);
      }),
      model('responses', async () => {
        respCalls++;
        return okStream('ok');
      }),
    ],
    (e) => events.push(e),
  );

  await wrapped.doStream(opts);
  await wrapped.doStream(opts);
  await wrapped.doStream(opts);

  expect(chatCalls).toBe(1);
  expect(respCalls).toBe(3);
  expect(events).toHaveLength(1);
});

test('the wrapper reports the primary provider and model id', () => {
  const wrapped = withFallback([model('chat-id', async () => okStream('x')), model('resp-id', async () => okStream('y'))]);
  expect(wrapped.modelId).toBe('chat-id');
  expect(wrapped.provider).toBe('test');
  expect(wrapped.specificationVersion).toBe('v4');
});
