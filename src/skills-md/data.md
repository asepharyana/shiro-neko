---
name: data
description: Process, validate, or transform data. Use when parsing files, cleaning datasets, designing a data pipeline, or debugging a transform that produces wrong output.
---

# Data

Bad data fails silently and far away from where it entered. Validate at the boundary, keep the
raw, and make every transform checkable.

## Validate at the boundary

Parse and validate when data enters the system, not when it is used. A schema check at the edge
turns a corrupt record into a clear rejection; skipping it turns the same record into a wrong
answer three layers later. Reject loudly, with the record and the reason — never coerce and
carry on.

## Keep the raw

Store the untransformed input alongside the derived. When a transform turns out to be wrong,
the raw lets you recompute; without it, the information is gone. Derived data is rebuildable;
source data is not.

## Transformations are pure and tested

A transform takes input and returns output with no hidden state, so it can be tested on a
fixture and re-run safely. Test the edge cases that actually occur in data: the empty field,
the wrong type, the unexpected null, the duplicate, the encoding that is not UTF-8.

## Duplicates, nulls, and ranges are the usual corruption

Check for: unexpected duplicates on a key, nulls where a value is required, values outside a
sane range (a negative age, a date in the future), and referential breaks (an id pointing at
nothing). These four catch most real-world data problems before they reach a report.

## Idempotent pipelines

A step that can be re-run without duplicating or corrupting its output is a step you can retry
after a failure. Key on a stable id and upsert rather than blind-insert. A pipeline you cannot
safely re-run is a pipeline you will one day have to fix by hand at 2am.
