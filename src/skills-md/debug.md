---
name: debug
description: Track down a bug whose cause is not obvious. Use when a test fails for unclear reasons, behaviour differs between environments, or an earlier fix did not hold.
---

# Debugging

Do not guess. A guess that happens to work leaves the real cause in place, and it will
fire again — usually in production, usually at a worse time.

## Reproduce first

Find the smallest command that shows the failure and record it with `remember`. If you
cannot reproduce it, say so and ask what the user did differently — do not proceed on a
hypothesis you cannot test.

Shrink the reproduction until it is minimal: one input, one call, one assertion. Every
moving part you leave in is a place the bug can hide. A reproduction that takes thirty
steps will not get run often enough to confirm the fix.

## Three hypotheses, then evidence

Write down at least three causes that would produce this exact symptom — not "the code is
wrong" but specific mechanisms: "the offset is off by one when the page is empty", "the
cache is read before the write lands". Rank them by how cheap they are to disprove, then
disprove them in that order. State which one you are testing before you test it.

Evidence means observed output: a log line, a failing assertion, a value printed at the
point of failure. "It should be X" is not evidence. When the evidence contradicts your
favoured hypothesis, the hypothesis is wrong — do not explain the evidence away.

## Localise before you fix

Assert the value at each boundary until one is wrong. The bug lives between the last
boundary where the value is right and the first where it is wrong. Fixing before you have
that bracket means editing the wrong place and learning nothing.

## Bisect when the space is large

- Recent regression: `git bisect` or read what changed last. The bug arrived in a commit;
  find which one.
- Unclear layer: assert the value at each boundary until one is wrong.
- Intermittent: run it in a loop and capture the failing case with full logging. Do not
  reason about a race abstractly — make it happen on demand, then it is no longer
  intermittent.

## Fix the cause, not the symptom

Once you know the cause, fix that and nothing else. Do not tidy surrounding code in the
same change — a bugfix diff should contain only the bug, so it can be reverted whole if it
is wrong.

Write a test that fails before the fix and passes after. Watch it fail first; a test you
never saw fail proves nothing. If you cannot express the bug as a test, say why — and say
what you ran instead to confirm the fix.

## After two failed attempts

Stop. Re-read the error text literally, character by character — most "impossible" bugs
are a misread message. Then check your assumption about which code is actually running:
the wrong file, a stale build, a shadowed import, a cached dependency, or an env var that
differs from your shell. Verify by printing something at the point you *think* executes;
if it does not print, that is your answer.
