---
name: refactor
description: Restructure code without changing behaviour. Use when asked to refactor, clean up, extract, or reorganise.
---

# Refactoring

Behaviour must not change. That is the whole constraint — every other goal (clarity,
structure, naming) is subordinate to it. The moment behaviour changes, you are no longer
refactoring, you are editing, and the safety argument below stops holding.

## Establish the safety net first

Run the existing tests and record that they pass — with `remember`, so the baseline
survives compaction. If the code has no tests, write one that pins current behaviour,
*including the ugly parts*: the odd return value, the quirk callers depend on. You are not
judging the behaviour, you are freezing it. Refactoring untested code is not refactoring;
it is rewriting, and it belongs under the edit workflow with its own verification.

## Then move in small steps

One transformation at a time, tests green between each. Rename, then extract, then move —
not all three in one edit. The mechanical refactorings are the safe ones: rename, extract
function, inline, move. Compose them. A large refactor that fails leaves you unable to
tell which of five steps broke it; a small one that fails tells you exactly which.

After each step, run the tests, not just the typechecker. Types catch signature drift;
they do not catch a reordered conditional or a dropped early return.

## What not to do

- Do not fix bugs while refactoring. Note them, finish the refactor green, then fix in a
  separate change — otherwise a regression could be either the refactor or the fix.
- Do not add abstraction for a single caller. Duplication beats a premature interface;
  the third caller is when the abstraction earns its name.
- Do not widen the scope. The request was this code, not its neighbours. A refactor that
  "while we're here" touches five more files is five more files of unreviewable risk.
- Do not change public API unless asked; if it must change, say so first and update every
  caller in the same change.

## Done means

Tests pass, behaviour is identical, and the diff is smaller than the reader feared. If the
diff is larger than the code it moved, you abstracted too early — put it back.
