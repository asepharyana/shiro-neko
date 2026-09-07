---
name: test
description: Write or repair tests. Use when adding coverage, fixing a flaky test, or asked how something should be tested.
---

# Testing

A test earns its place by failing when the code is wrong. A test that cannot fail — or
that passes regardless — is not a test, it is overhead with a green checkmark.

## Match the project

Read two existing test files first. Use their runner, their assertion style, their file
layout, their naming, their way of building fixtures. A test that looks foreign is a test
nobody maintains, and an unmaintained test is deleted the first time it goes red.

## Test behaviour, not implementation

Assert on what a caller observes: the return value, the written file, the emitted event,
the status code. A test that reaches into private state or mocks a collaborator's
internals breaks on every refactor while catching nothing real. If you cannot say what
the caller sees, you are testing the how, and the how is allowed to change.

Cover, in this order of value:
- **The failure** — the bad input, the missing file, the null. Failure cases catch more
  real defects than happy paths, because most code is written for the happy path first.
- **The boundaries** — empty, one, the maximum, off-by-one at each edge.
- **The normal case** — one, to prove the wiring works at all.

## Never do this

- Do not assert what the code currently returns without knowing it is correct — that pins
  the bug into the suite and calls it a specification.
- Do not weaken an assertion to make a test pass. If it fails, either the code or the
  expectation is wrong; find out which before you touch either.
- Do not delete a failing test to go green. It is telling you something; listen.
- Do not test the framework or the library. Your code is the subject; their code has its
  own suite.

## Flaky tests

A test that passes alone and fails in a suite is a shared-state problem: a global, a temp
directory, a port, an unawaited promise, leftover data, or ordering. Find which — run it
repeatedly and in isolation to confirm, then remove the shared state. Do not add a retry:
a retried flake is a real intermittent bug you have decided to stop hearing about.

## Verify

Run the test and watch it fail before the fix, pass after. A test you never saw fail is
not known to test anything.
