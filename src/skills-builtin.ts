/**
 * Skills bundled with the binary.
 *
 * These are string constants rather than files on disk because `bun build --compile`
 * only embeds modules reachable through imports; a directory of .md files would be
 * missing from the shipped binary.
 */
export const BUILTIN_SKILLS: { name: string; source: string }[] = [
  {
    name: 'debug',
    source: `---
name: debug
description: Track down a bug whose cause is not obvious. Use when a test fails for unclear reasons, behaviour differs between environments, or an earlier fix did not hold.
---

# Debugging

Do not guess. A guess that happens to work leaves the real cause in place.

## Reproduce first

Find the smallest command that shows the failure and record it with \`remember\`. If you
cannot reproduce it, say so and ask what the user did differently — do not proceed on a
hypothesis you cannot test.

## Three hypotheses, then evidence

Write down at least three causes that would produce this exact symptom. Rank them by how
cheap they are to disprove, then disprove them in that order. State which one you are
testing before you test it.

Evidence means observed output: a log line, a failing assertion, a value printed at the
point of failure. "It should be X" is not evidence.

## Bisect when the space is large

- Recent regression: check what changed last.
- Unclear layer: assert the value at each boundary until one is wrong.
- Intermittent: run it in a loop and capture the failing case, do not reason about it abstractly.

## Fix the cause

Once you know the cause, fix that and nothing else. Do not tidy surrounding code in the
same change — a bugfix diff should contain only the bug.

Write a test that fails before the fix and passes after. If you cannot express the bug as
a test, say why.

## After two failed attempts

Stop. Re-read the error text literally, character by character. Check your assumption
about which code is actually running: the wrong file, a stale build, a shadowed import,
or a cached dependency accounts for most "impossible" bugs.
`,
  },
  {
    name: 'review',
    source: `---
name: review
description: Review a diff or a file for defects. Use when asked to review, critique, or check code before it ships.
---

# Code review

Severity order. Do not lead with style.

1. **Incorrect behaviour** — wrong result, wrong edge case, wrong state after failure.
2. **Missing validation at trust boundaries** — user input, network responses, file contents,
   anything crossing a process line. Internal calls need no defensive checks.
3. **Security** — injection, path traversal, secrets in logs or errors, missing authz.
4. **Resource handling** — unclosed handles, unbounded growth, unawaited promises.
5. **Clarity** — only when it will cause a future defect.

## For each finding

State file and line, what breaks, and the change. Show the fix as code when it is short.

Skip anything a formatter would fix. Skip preference. If a choice is defensible, leave it.

## Say when it is fine

A review that invents problems to look thorough is worse than a short one. If the change
is correct, say so and stop.

## Verify, do not assume

Read the surrounding code before calling something a bug. A "missing" null check often
exists one level up. Run the tests if that is what settles it.
`,
  },
  {
    name: 'refactor',
    source: `---
name: refactor
description: Restructure code without changing behaviour. Use when asked to refactor, clean up, extract, or reorganise.
---

# Refactoring

Behaviour must not change. That is the whole constraint.

## Establish the safety net first

Run the existing tests and record that they pass. If the code has no tests, write one that
pins current behaviour — including the ugly parts — before touching anything. Refactoring
untested code is rewriting it.

## Then move in small steps

One transformation at a time, tests green between each. Rename, then extract, then move —
not all three in one edit. A large refactor that fails leaves you unable to tell which step
broke it.

## What not to do

- Do not fix bugs while refactoring. Note them, finish, fix separately.
- Do not add abstraction for a single caller. Duplication beats a premature interface.
- Do not widen the scope. The request was this code, not its neighbours.
- Do not change public API unless asked; if it must change, say so first.

## Done means

Tests pass, behaviour is identical, and the diff is smaller than the reader feared.
`,
  },
  {
    name: 'test',
    source: `---
name: test
description: Write or repair tests. Use when adding coverage, fixing a flaky test, or asked how something should be tested.
---

# Testing

A test earns its place by failing when the code is wrong.

## Match the project

Read two existing test files first. Use their runner, their assertion style, their file
layout, their naming. A test that looks foreign is a test nobody maintains.

## Test behaviour, not implementation

Assert on what a caller observes. A test that reaches into private state breaks on every
refactor and catches nothing.

Cover: the normal case, the boundaries, and the failure. Failure cases catch more real
defects than happy paths.

## Never do this

- Do not assert what the code currently returns without knowing it is correct — that pins
  the bug.
- Do not weaken an assertion to make a test pass. If it fails, either the code or the
  expectation is wrong; find out which.
- Do not delete a failing test. It is telling you something.

## Flaky tests

A test that passes alone and fails in a suite is a shared-state problem: a global, a
temp directory, a port, an unawaited promise, or ordering. Find which, do not add a retry.

## Verify

Run the test and watch it fail before the fix, pass after. A test you never saw fail is
not known to work.
`,
  },
  {
    name: 'verify',
    source: `---
name: verify
description: Confirm a change actually works by using it, not by reading it. Use before reporting a task complete, or when asked whether something works.
---

# Verification

A green test suite says the tests pass. It does not say the feature works.

## Run the artifact, not the source

Build it and use it the way a user would:

- **CLI** — build the binary and run it. Happy path, bad input, \`--help\`. Read the output.
- **HTTP service** — start it and \`curl\` the endpoint. Check the status and the body.
- **Library** — write a throwaway script that imports and calls the new code end to end.
- **Script or job** — run it against real input and inspect what it produced.

Delete the throwaway afterwards.

## What counts as evidence

Command output you actually saw. Paste the relevant lines, not a summary of them.

These are not evidence:

- "The tests pass" for a change tests do not cover.
- "The types check" for anything about runtime behaviour.
- "It should work now" for anything at all.

## Check the failure path too

Feed it the input you expect to be rejected and confirm it is rejected, with a message
that says why. A feature that works only on correct input is half-built.

## Report what you did not verify

Say plainly what you could not run and why: a missing credential, a service you cannot
start, a platform you are not on. An honest gap is useful; a claim that hides one is not.

## When verification fails

The defect is yours to fix in this turn. Do not report the task complete with a note that
it did not work.
`,
  },
  {
    name: 'commit',
    source: `---
name: commit
description: Stage and commit work. Use when asked to commit, or to split existing changes into commits.
---

# Committing

Never commit unless the user asked. If it is unclear whether they did, ask.

## Look before you stage

\`git_status\` and \`git_diff\` first. You are looking for two things:

1. Changes that are not yours. Another agent or the user may share this worktree, and
   \`git add .\` takes their half-finished work with yours.
2. Files that should never be committed: \`.env\`, credentials, keys, large build output,
   anything a \`.gitignore\` rule was supposed to catch and did not. Flag these to the user
   rather than committing them.

Stage the specific paths you changed. \`git add .\` is how unrelated work ends up in a
commit that then has to be reverted whole.

## One commit, one reason

If the diff does two unrelated things, make two commits. A commit that both fixes a bug and
renames a module cannot be reverted, cherry-picked, or bisected usefully.

## The message

Match the repository's existing style — read \`git_log\` before writing one. Failing that:

- A subject line under 70 characters, imperative, saying what changed.
- A body explaining *why*, when the reason is not obvious from the diff. Wrap at 72.
- No "as requested", no restating the diff line by line, no emoji unless the repo uses them.

## Do not

- Do not \`--amend\` a commit that has been pushed. Write a new one.
- Do not \`--no-verify\`. If a hook rejects the commit, the hook found something.
- Do not \`git push\` unless asked, and never force-push without being asked explicitly.
- Do not commit and then immediately fix it up with a second commit. Get it right, or say
  what is wrong.

## After committing

Report the short hash and the subject. If a hook rewrote files, say so and confirm the
final state is what was intended.
`,
  },
];
