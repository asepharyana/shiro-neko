import { expect, test } from 'bun:test';
import { MUTATING_TOOLS, TOOL_META, tools } from '../src/tools';
import { GIT_TOOL_NAMES } from '../src/tools-git';
import { NET_TOOL_NAMES } from '../src/tools-net';

/**
 * Derived tool metadata: the effect of every built-in tool is declared in one
 * TOOL_META map, so a tool added to the registry but not classified (or mutated
 * but missed from MUTATING_TOOLS) fails here instead of silently skipping the
 * approval gate. This is the guard the ROADMAP asked for.
 */
test('every built-in tool is classified in TOOL_META', () => {
  const registered = Object.keys(tools);
  const classified = Object.keys(TOOL_META);
  const unclassified = registered.filter((name) => !classified.includes(name));
  expect(unclassified).toEqual([]);
});

test('MUTATING_TOOLS exactly matches the mutate-classified tools', () => {
  const mutant = Object.entries(TOOL_META)
    .filter(([, effect]) => effect === 'mutate')
    .map(([name]) => name)
    .sort();
  const declared: string[] = [...MUTATING_TOOLS].sort();
  expect(declared).toEqual(mutant);
});

test('the net tools are classified net and never mutating', () => {
  for (const name of NET_TOOL_NAMES) {
    expect(TOOL_META[name]).toBe('net');
    expect(MUTATING_TOOLS).not.toContain(name);
  }
});

test('the git tools are classified read-only', () => {
  for (const name of GIT_TOOL_NAMES) {
    expect(TOOL_META[name]).toBe('read');
    expect(MUTATING_TOOLS).not.toContain(name);
  }
});
