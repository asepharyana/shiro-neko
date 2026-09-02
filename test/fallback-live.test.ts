import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamText, tool } from 'ai';
import { z } from 'zod';
import { resolveModel, type Config } from '../src/config';
import { fallbackChainOf, type FallbackEvent } from '../src/fallback';

let home: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['SHIRO_HOME', 'SHIRO_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  home = mkdtempSync(join(tmpdir(), 'shiro-live-'));
  process.env['SHIRO_HOME'] = home;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

const chatDone = [
  sse({ id: '1', choices: [{ index: 0, delta: { role: 'assistant', content: 'chat path' } }] }),
  sse({ id: '1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } }),
  'data: [DONE]\n\n',
].join('');

const REJECT_BODY = JSON.stringify({
  error: {
    message:
      "Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
    type: 'invalid_request_error',
    param: 'reasoning_effort',
    code: null,
  },
});

/** Minimal /v1/responses SSE conversation ending in a completed response. */
const responsesDone = [
  sse({
    type: 'response.created',
    response: { id: 'resp_1', created_at: 1, model: 'gpt-5.6-sol', object: 'response', status: 'in_progress', output: [] },
  }),
  sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } }),
  sse({ type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } }),
  sse({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'responses path' }),
  sse({ type: 'response.output_text.done', item_id: 'msg_1', output_index: 0, content_index: 0, text: 'responses path' }),
  sse({ type: 'response.content_part.done', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: 'responses path' } }),
  sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'responses path' }] } }),
  sse({
    type: 'response.completed',
    response: {
      id: 'resp_1',
      created_at: 1,
      model: 'gpt-5.6-sol',
      object: 'response',
      status: 'completed',
      output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'responses path' }] }],
      usage: { input_tokens: 5, output_tokens: 3 },
    },
  }),
].join('');

const eventStream = (body: string) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });

async function collect(model: Parameters<typeof streamText>[0]['model'], signalTools: boolean) {
  const result = streamText({
    model,
    prompt: 'hi',
    maxRetries: 0,
    ...(signalTools
      ? { tools: { ping: tool({ description: 'ping', inputSchema: z.object({}) }) } }
      : {}),
  });
  void result.responseMessages.then(undefined, () => {});
  void result.usage.then(undefined, () => {});
  let text = '';
  for await (const part of result.stream) if (part.type === 'text-delta') text += part.text;
  return text;
}

test('a chat-completions rejection of function tools switches to /v1/responses', async () => {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      hits.push(path);
      if (path === '/v1/chat/completions') {
        return new Response(REJECT_BODY, { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return eventStream(responsesDone);
    },
  });

  const events: FallbackEvent[] = [];
  const cfg: Config = {
    provider: 'openai',
    model: 'gpt-5.6-sol',
    apiKey: 'sk-test',
    baseURL: `http://127.0.0.1:${server.port}/v1`,
  };

  // resolveModel only chains the fallback for api.openai.com, so drive the wrapper
  // the same way production does but pointed at the local server.
  const { withFallback } = await import('../src/fallback');
  const { createOpenAI } = await import('@ai-sdk/openai');
  const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
  const chat = createOpenAICompatible({ name: 'openai', apiKey: cfg.apiKey!, baseURL: cfg.baseURL! })(cfg.model);
  const responses = createOpenAI({ apiKey: cfg.apiKey!, baseURL: cfg.baseURL! }).responses(cfg.model);

  const text = await collect(withFallback([chat, responses], (e) => events.push(e)), true);
  server.stop(true);

  expect(text).toBe('responses path');
  expect(hits).toEqual(['/v1/chat/completions', '/v1/responses']);
  expect(events).toHaveLength(1);
  expect(events[0]?.reason).toContain('400');
});

test('when chat-completions works, /v1/responses is never touched', async () => {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => {
      hits.push(new URL(req.url).pathname);
      return eventStream(chatDone);
    },
  });

  const { withFallback } = await import('../src/fallback');
  const { createOpenAI } = await import('@ai-sdk/openai');
  const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
  const base = `http://127.0.0.1:${server.port}/v1`;
  const chat = createOpenAICompatible({ name: 'openai', apiKey: 'sk', baseURL: base })('gpt-5');
  const responses = createOpenAI({ apiKey: 'sk', baseURL: base }).responses('gpt-5');

  const events: FallbackEvent[] = [];
  const text = await collect(withFallback([chat, responses], (e) => events.push(e)), false);
  server.stop(true);

  expect(text).toBe('chat path');
  expect(hits).toEqual(['/v1/chat/completions']);
  expect(events).toEqual([]);
});

test('official OpenAI gets the chat -> responses chain', () => {
  const model = resolveModel({ provider: 'openai', model: 'gpt-5.6-sol', apiKey: 'sk-x' });
  expect(fallbackChainOf(model)).toEqual(['openai.chat/gpt-5.6-sol', 'openai.responses/gpt-5.6-sol']);
});

test('a non-OpenAI endpoint gets a plain chat model with no fallback chain', () => {
  const model = resolveModel({
    provider: 'openai',
    model: 'llama-3.3',
    apiKey: 'gsk_x',
    baseURL: 'https://api.groq.com/openai/v1',
  });
  expect(typeof model).not.toBe('string');
  expect(fallbackChainOf(model)).toBeUndefined();
});

test('anthropic is left alone: no responses endpoint exists there', () => {
  const model = resolveModel({ provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-ant' });
  expect(fallbackChainOf(model)).toBeUndefined();
});

test('the SDK retries a retryable failure the configured number of times', async () => {
  let attempts = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => {
      attempts++;
      if (attempts <= 2) return new Response('overloaded', { status: 503 });
      return eventStream(chatDone);
    },
  });

  const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
  const model = createOpenAICompatible({
    name: 'openai',
    apiKey: 'sk',
    baseURL: `http://127.0.0.1:${server.port}/v1`,
  })('gpt-5');

  const result = streamText({ model, prompt: 'hi', maxRetries: 3 });
  void result.responseMessages.then(undefined, () => {});
  void result.usage.then(undefined, () => {});
  let text = '';
  for await (const part of result.stream) if (part.type === 'text-delta') text += part.text;
  server.stop(true);

  expect(attempts).toBe(3);
  expect(text).toBe('chat path');
}, 20_000);
