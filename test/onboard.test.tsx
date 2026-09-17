import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import type { Config } from '../src/config';
import { Onboard, type OnboardResult } from '../src/ui/Onboard';

/**
 * The provider wizard had no test because its every path but the first ends at a
 * network call. That call is `fetchModels`, which uses the global `fetch`, so the
 * suite stubs it: the picking, the env-key shortcut, the manual-entry fallback,
 * and the empty-list warning are all reachable offline and deterministic.
 *
 * `current` decides the starting row, so a test selects a preset by naming it
 * rather than counting arrow presses.
 */

const DOWN = '\u001B[B';
const ENTER = '\r';
const ESC = '\u001B';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ORIGINAL_FETCH = globalThis.fetch;

/** Answers `GET /models` with the given ids; the wizard sorts them itself. */
function stubModels(ids: string[]): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return calls;
}

function stubFailure(status: number): void {
  globalThis.fetch = (async () => new Response('boom', { status })) as unknown as typeof fetch;
}

beforeEach(() => {
  // The wizard reads the preset's env key to skip the api-key step; a developer's
  // shell must not decide which branch a test takes.
  delete process.env['ANTHROPIC_API_KEY'];
  delete process.env['OPENAI_API_KEY'];
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env['ANTHROPIC_API_KEY'];
  delete process.env['OPENAI_API_KEY'];
});

afterAll(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

async function press(app: ReturnType<typeof render>, s: string, ms = 80) {
  app.stdin.write(s);
  await wait(ms);
}

async function type(app: ReturnType<typeof render>, s: string) {
  for (const ch of s) await press(app, ch, 20);
}

function mount(current: Partial<Config> = {}) {
  const done: OnboardResult[] = [];
  let cancelled = 0;
  const app = render(
    <Onboard
      current={{ provider: 'anthropic', model: 'claude-sonnet-4-5', ...current }}
      onDone={(r) => done.push(r)}
      onCancel={() => void cancelled++}
    />,
  );
  return { app, done, cancelled: () => cancelled };
}

test('the first screen lists providers and marks the configured one', async () => {
  const { app, cancelled } = mount({ presetId: 'openai' });
  await wait(80);

  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('Choose a provider');
  expect(frame).toContain('Anthropic');
  expect(frame).toContain('OpenAI  (current)');
  expect(frame).toContain('Custom OpenAI-compatible endpoint');

  await press(app, ESC, 120);
  expect(cancelled()).toBe(1);
  app.unmount();
}, 20_000);

test('esc cancels from the api-key step', async () => {
  // custom-openai has no env key, so it stops for a key rather than calling out.
  const { app, cancelled } = mount({ presetId: 'custom-openai' });
  await wait(80);

  await press(app, ENTER, 120);
  await type(app, 'https://ex.com/v1');
  await press(app, ENTER, 120);
  expect(app.lastFrame()).toContain('API key');

  await press(app, ESC, 120);
  expect(cancelled()).toBe(1);
  app.unmount();
}, 20_000);

test('a custom endpoint collects url, key, and a chosen model', async () => {
  const calls = stubModels(['m2', 'm1']);
  const { app, done } = mount({ presetId: 'custom-openai' });
  await wait(80);

  await press(app, ENTER, 120);
  expect(app.lastFrame()).toContain('endpoint URL');

  await type(app, 'https://ex.com/v1');
  await press(app, ENTER, 120);
  expect(app.lastFrame()).toContain('API key');

  await type(app, 'sk-secret-key');
  await press(app, ENTER, 200);
  expect(app.lastFrame()).toContain('choose a model');

  // The list arrives sorted, so the first row is m1, not the m2 it was given.
  await press(app, ENTER, 150);

  expect(calls).toEqual(['https://ex.com/v1/models']);
  expect(done).toEqual([
    {
      presetId: 'custom-openai',
      provider: 'openai',
      baseURL: 'https://ex.com/v1',
      apiKey: 'sk-secret-key',
      model: 'm1',
    },
  ]);
  app.unmount();
}, 20_000);

test('an env key skips the key step and the hint masks it', async () => {
  process.env['OPENAI_API_KEY'] = 'sk-abcdefgh1234';
  stubModels(['gpt-5', 'gpt-5-mini']);
  const { app } = mount({ presetId: 'openai' });
  await wait(80);

  await press(app, ENTER, 200);

  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('choose a model');
  expect(frame).toContain('sk-a...1234');
  app.unmount();
}, 20_000);

test('the manual entry collects a model id the list does not offer', async () => {
  // The env key is what skips the key step; without it the wizard would stop there.
  process.env['OPENAI_API_KEY'] = 'sk-manual-test-key';
  stubModels(['only-one']);
  const { app, done } = mount({ presetId: 'openai' });
  await wait(80);

  await press(app, ENTER, 200);
  expect(app.lastFrame()).toContain('choose a model');

  await press(app, DOWN, 100); // one model, then the manual-entry row
  await press(app, ENTER, 120);
  expect(app.lastFrame()).toContain('model id');

  await type(app, 'my-model');
  await press(app, ENTER, 150);

  expect(done).toHaveLength(1);
  expect(done[0]?.model).toBe('my-model');
  app.unmount();
}, 20_000);

test('a server that cannot list models falls through to the warning', async () => {
  // custom-openai has no fallback list, so an empty response leaves nothing to pick.
  stubFailure(500);
  const { app } = mount({ presetId: 'custom-openai' });
  await wait(80);

  await press(app, ENTER, 120);
  await type(app, 'https://ex.com/v1');
  await press(app, ENTER, 120);
  await type(app, 'sk-x');
  await press(app, ENTER, 250);

  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('could not list models');
  expect(frame).toContain('model id');
  app.unmount();
}, 20_000);
