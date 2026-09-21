import type { Tool } from 'ai';

/**
 * Marks a tool as mutating where it is defined, rather than in a list beside it.
 *
 * The bug this prevents is the worst one this codebase can have: a new tool that
 * writes to the workspace, added to `tools` but forgotten in a hand-maintained
 * `MUTATING_TOOLS`, is a write the permission layer does not treat as a write. It
 * is silent, it passes every test that does not think to check the new name, and
 * it surfaces as a user discovering an edit they never approved.
 *
 * The mark is a property on the tool object, so `MUTATING_TOOLS` can be derived by
 * filtering the registry instead of being typed out. A tool that is not marked is
 * asserted non-mutating by `tools.test.ts`, which means the decision is made once,
 * at the definition, and cannot drift.
 */
export const MUTATING = '__mutating' as const;

/** A tool that can change the workspace or run arbitrary code. */
export function mutating<T extends Tool>(t: T): T {
  return Object.assign(t, { [MUTATING]: true as const });
}

/** Whether a tool was declared mutating at its definition site. */
export function isMutating(t: unknown): boolean {
  return typeof t === 'object' && t !== null && (t as Record<string, unknown>)[MUTATING] === true;
}
