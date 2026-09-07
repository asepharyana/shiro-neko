---
name: plan
description: Break a non-trivial task into an ordered, verifiable sequence before writing code. Use when a request is large, spans several files, or its steps depend on each other.
---

# Planning

A plan that cannot be checked is a wish. Every step ends in something you can run.

## Understand before you sequence

Read enough to know the real shape of the work: the entry point, the data's path, the
module that owns the behaviour. A plan made from filenames alone reorders itself the
moment you open the first file. Grep the actual call sites; do not plan around a guess.

## Order by dependency, not by file

A step may depend on another's output: a type before its callers, a schema before its
migration, a test helper before the tests that use it. Sequence so nothing references
what does not exist yet. If two steps are independent, say so — the order between them
is free and you may take the cheaper one first to derisk the rest.

## One step, one verifiable outcome

Each step names the command that proves it done: a test that passes, a build that
compiles, a script that runs. "Wire it up" is not a step. Write the list with
`todo_write`, then work it in order, marking done immediately — not in a batch at the end.

## Keep it small

The plan is a scaffold, not the building. If a step grows past "change these few files",
split it. If the task turns out smaller than it looked, drop the remaining steps and say
why rather than inventing work to fill them.

## Replan when the ground moves

New information that changes the order or the scope is a reason to rewrite the list, not
to push through it. A stale plan followed faithfully is worse than no plan.
