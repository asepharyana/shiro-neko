import { expect, test } from 'bun:test';
import { DEFAULT_VARIANT, isThinkingLevel, renderAgent, resolveAgent, sdkReasoning, THINKING_LEVELS, VARIANTS, variantByName } from '../src/agents';

test('every variant has a name, summary, and thinking level', () => {
  for (const v of VARIANTS) {
    expect(v.name).toBeTruthy();
    expect(v.summary).toBeTruthy();
    expect(THINKING_LEVELS).toContain(v.thinking);
  }
});

test('variant names are unique', () => {
  const names = VARIANTS.map((v) => v.name);
  expect(new Set(names).size).toBe(names.length);
});

test('thinking levels map to the SDK vocabulary', () => {
  expect(sdkReasoning('off')).toBe('none');
  expect(sdkReasoning('low')).toBe('low');
  expect(sdkReasoning('medium')).toBe('medium');
  expect(sdkReasoning('high')).toBe('high');
  expect(sdkReasoning('max')).toBe('xhigh');
});

test('isThinkingLevel accepts the five levels and nothing else', () => {
  for (const l of THINKING_LEVELS) expect(isThinkingLevel(l)).toBe(true);
  expect(isThinkingLevel('ultra')).toBe(false);
  expect(isThinkingLevel('')).toBe(false);
});

test('the default variant is balanced and unrestricted', () => {
  expect(DEFAULT_VARIANT.name).toBe('default');
  expect(DEFAULT_VARIANT.thinking).toBe('medium');
  expect(DEFAULT_VARIANT.allowTools).toBeUndefined();
});

test('quick spends no thinking budget and caps steps', () => {
  const quick = variantByName('quick')!;
  expect(quick.thinking).toBe('off');
  expect(quick.maxSteps).toBeLessThan(20);
});

test('deep asks for maximum thinking and allows more steps', () => {
  const deep = variantByName('deep')!;
  expect(deep.thinking).toBe('max');
  expect(deep.maxSteps).toBeGreaterThan(50);
});

test('plan and review are read-only: no write, edit, or bash', () => {
  for (const name of ['plan', 'review']) {
    const v = variantByName(name)!;
    expect(v.allowTools).toBeDefined();
    expect(v.allowTools).not.toContain('write_file');
    expect(v.allowTools).not.toContain('edit_file');
    expect(v.allowTools).not.toContain('bash');
    expect(v.allowTools).toContain('read_file');
    expect(v.allowTools).toContain('grep');
  }
});

test('resolveAgent with no arguments yields the default', () => {
  expect(resolveAgent(undefined, undefined).name).toBe('default');
});

test('resolveAgent looks a variant up by name', () => {
  expect(resolveAgent('deep', undefined).name).toBe('deep');
});

test('an explicit thinking level overrides the variant default', () => {
  const v = resolveAgent('deep', 'low');
  expect(v.name).toBe('deep');
  expect(v.thinking).toBe('low');
  // The override must not mutate the shared preset.
  expect(variantByName('deep')!.thinking).toBe('max');
});

test('an unknown agent name is rejected with the available list', () => {
  expect(() => resolveAgent('turbo', undefined)).toThrow(/Unknown agent "turbo"/);
  expect(() => resolveAgent('turbo', undefined)).toThrow(/default/);
});

test('an unknown thinking level is rejected', () => {
  expect(() => resolveAgent('deep', 'ludicrous')).toThrow(/Unknown thinking level/);
});

test('renderAgent emits nothing for the default so the prompt stays clean', () => {
  expect(renderAgent(DEFAULT_VARIANT)).toBe('');
});

test('renderAgent emits the appendix for a shaped variant', () => {
  expect(renderAgent(variantByName('plan')!)).toContain('planning mode');
  expect(renderAgent(variantByName('review')!)).toContain('reviewing code');
});
