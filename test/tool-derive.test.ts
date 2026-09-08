import { expect, test } from 'bun:test';
import { DEFAULT_PERMISSIONS } from '../src/permission';
import { tools, TOOL_SETS, MUTATING_TOOLS, TOOL_SET_NAMES } from '../src/tools';
import { assertAllToolsInSets, mutatingNames, setsFrom, type ToolMeta } from '../src/tool-utils';

test('every builtin tool carries _meta at its definition site', () => {
  for (const [name, t] of Object.entries(tools as Record<string, { _meta?: ToolMeta }>)) {
    const meta = t._meta;
    expect(meta, `${name} has no _meta — wrap it with withMeta at the definition site`).toBeDefined();
    expect(TOOL_SET_NAMES as readonly string[]).toContain(meta!.set);
    expect(typeof meta!.mutating).toBe('boolean');
  }
});

test('TOOL_SETS is derived from _meta and covers every builtin tool exactly once', () => {
  const derived = setsFrom(tools as Record<string, { _meta?: ToolMeta }>);
  expect(TOOL_SETS).toEqual(derived);

  const missing = assertAllToolsInSets(tools, TOOL_SETS);
  expect(missing).toEqual([]);

  // no tool belongs to two sets
  const all = Object.values(TOOL_SETS).flat();
  expect(new Set(all).size).toBe(all.length);
  expect(all.length).toBe(Object.keys(tools).length);

  // every name in a set is a real tool
  for (const name of all) expect(tools).toHaveProperty(name);
});

test('MUTATING_TOOLS is exactly the set of tools with _meta.mutating', () => {
  const derived = mutatingNames(tools as Record<string, { _meta?: ToolMeta }>);
  expect([...MUTATING_TOOLS].sort()).toEqual(derived);
});

test('every mutating tool has a DEFAULT_PERMISSIONS entry (otherwise it would run ungated)', () => {
  for (const name of MUTATING_TOOLS) {
    expect(DEFAULT_PERMISSIONS[name], `${name} mutates but has no DEFAULT_PERMISSIONS entry`).toBeDefined();
  }
});

test('a mutating tool outside MUTATING_TOOLS would be caught: the derive is the single source of truth', () => {
  // This is the invariant the hand-list used to break: a tool with mutating:true
  // must appear in MUTATING_TOOLS, and a tool without it must not.
  for (const [name, t] of Object.entries(tools as Record<string, { _meta?: ToolMeta }>)) {
    const isMutating = (t._meta?.mutating ?? false);
    const inList = (MUTATING_TOOLS as readonly string[]).includes(name);
    expect(inList, `${name}: _meta.mutating=${isMutating} but MUTATING_TOOLS includes=${inList}`).toBe(isMutating);
  }
});
