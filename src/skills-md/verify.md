---
name: verify
description: Confirm a change actually works by using it, not by reading it. Use before reporting a task complete, or when asked whether something works.
---

# Verification

A green test suite says the tests pass. It does not say the feature works. The two are
different claims, and only one of them is what the user asked for.

## Run the artifact, not the source

Build it and use it the way a user would, end to end:

- **CLI** — build the binary and run it. Happy path, bad input, `--help`. Read the actual
  output, not the output you expected.
- **HTTP service** — start it and `curl` the endpoint. Check the status line and the body,
  not just that it returned something.
- **Library** — write a throwaway script that imports and calls the new code end to end,
  the way a consumer would.
- **Script or job** — run it against real input and inspect what it produced.

Delete the throwaway afterwards. A verification script left behind becomes clutter the
next person trips over.

## What counts as evidence

Command output you actually saw. Paste the relevant lines, not a summary of them — a
summary hides the one line that mattered.

These are not evidence:

- "The tests pass" for a change the tests do not cover.
- "The types check" for anything about runtime behaviour.
- "It compiles" for anything about correctness.
- "It should work now" for anything at all.

## Check the failure path too

Feed it the input you expect to be rejected and confirm it is rejected, with a message
that says why. Then the edge case at the boundary. A feature that works only on correct
input is half-built, and the half that is missing is the half users hit first.

## Report what you did not verify

Say plainly what you could not run and why: a missing credential, a service you cannot
start, a platform you are not on. An honest gap is useful — the reader can fill it. A
claim that hides one is a bug you just shipped in prose.

## When verification fails

The defect is yours to fix in this turn. Do not report the task complete with a note that
it did not work — that is a failure report, not a completion.
