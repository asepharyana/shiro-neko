import { expect, test } from 'bun:test';
import { costOf, formatUsd, rateFor, usageLine } from '../src/pricing';

test('a known model resolves to a rate', () => {
  expect(rateFor('gpt-5')).toEqual({ inputPerMTok: 1.25, outputPerMTok: 10 });
  expect(rateFor('claude-sonnet-4-5')).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
});

test('a dated model id resolves through its prefix', () => {
  expect(rateFor('claude-sonnet-4-5-20250929')).toEqual(rateFor('claude-sonnet-4'));
});

test('the longest matching prefix wins so mini does not resolve to the base model', () => {
  expect(rateFor('gpt-5-mini')?.inputPerMTok).toBe(0.25);
  expect(rateFor('gpt-5')?.inputPerMTok).toBe(1.25);
  expect(rateFor('gpt-5-nano')?.inputPerMTok).toBe(0.05);
});

test('an OpenRouter-style prefixed id is stripped before matching', () => {
  expect(rateFor('anthropic/claude-sonnet-4-5')).toEqual(rateFor('claude-sonnet-4-5'));
  expect(rateFor('openai/gpt-5-mini')).toEqual(rateFor('gpt-5-mini'));
});

test('matching is case-insensitive', () => {
  expect(rateFor('GPT-5')).toEqual(rateFor('gpt-5'));
});

test('an unknown model has no rate and no cost', () => {
  expect(rateFor('some-local-llama')).toBeUndefined();
  expect(costOf('some-local-llama', 1000, 500)).toBeUndefined();
});

test('cost is computed per million tokens', () => {
  // 1M in at $1.25 plus 1M out at $10.
  expect(costOf('gpt-5', 1_000_000, 1_000_000)).toBeCloseTo(11.25, 6);
  expect(costOf('gpt-5', 500_000, 0)).toBeCloseTo(0.625, 6);
  expect(costOf('gpt-5', 0, 0)).toBe(0);
});

test('formatUsd keeps sub-cent amounts visible', () => {
  expect(formatUsd(0)).toBe('$0.00');
  expect(formatUsd(0.0001234)).toBe('$0.0001');
  expect(formatUsd(0.005)).toBe('$0.0050');
  expect(formatUsd(1.239)).toBe('$1.24');
  expect(formatUsd(12)).toBe('$12.00');
});

test('usageLine reports tokens plus dollars for a priced model', () => {
  const line = usageLine('gpt-5', 10_000, 2_000);
  expect(line).toContain('10000 in / 2000 out tokens');
  expect(line).toContain('$0.03');
});

test('usageLine says so plainly when the model is unpriced', () => {
  const line = usageLine('qwen-local', 10, 5);
  expect(line).toContain('10 in / 5 out tokens');
  expect(line).toContain('unpriced');
  expect(line).not.toContain('$');
});
