---
name: perf
description: Make something faster, or find out why it is slow. Use when a command, request, test suite, or build takes longer than it should.
---

# Performance

Measure first. A change made without a number before it is a guess with extra steps, and
most "optimisations" made on a guess make the code worse and no faster.

## Get a number

Time the actual operation, not a proxy for it: `time`, the framework's own timing output,
or a loop around the slow call with a timestamp either side. Use realistic input — a fast
result on a tiny fixture tells you nothing about the production case. Record the baseline
with `remember` so the comparison survives compaction, and run it enough times that a
warm cache and jitter do not fool you.

If you cannot measure it, say so and stop. Optimising an unmeasured path is how a codebase
accumulates complexity that buys nothing.

## Find where the time goes

- **Wall-clock dominated by one call?** Look there and nowhere else. The biggest node is
  the only one worth touching.
- **Spread evenly?** Suspect the loop around it: an O(n²) walk, a query per row, a file
  read per iteration, an allocation per element.
- **Idle time?** It is waiting, not computing: a sequential chain of independent awaits, an
  unpooled connection, a contended lock, a slow remote call.

The usual culprits, in the order they actually appear: N+1 queries, work repeated inside a
loop that could be hoisted, a missing index, sequential awaits that could run together,
reading a whole file to use one line, and re-parsing something that could be parsed once.

## Change one thing

One change, then re-measure on the same setup. Two changes together and you do not know
which one paid — and one of them may have cost. If the number did not move, revert the
change; an optimisation that does not measure is just complexity.

## Stop when it is fast enough

State the target before you start: "the test suite under a minute", "the endpoint under
200ms". Past the target, further work is complexity with no user on the other end of it.

## Report

Baseline, the change, the new number, and what you deliberately did not do. A 40% win with
one line changed is a better report than a 45% win that restructured a module.
