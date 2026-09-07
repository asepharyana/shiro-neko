---
name: logging
description: Add or improve logging and observability. Use when debugging in production, adding structured logs, choosing log levels, or making a system traceable.
---

# Logging

Logs are how you debug a system you cannot attach a debugger to. Write them for the 3am
incident, not the happy path.

## Structure over prose

Emit fields, not sentences: `{ user: id, action: "checkout", ms: 142, ok: false }`, not
`"User checked out"`. Structured logs are searchable and aggregable; a sentence is neither.
One event, one line, one level.

## Levels are a contract

- `error` — something is broken and someone should look. Not "a user gave bad input".
- `warn` — unexpected but handled; worth a glance.
- `info` — the meaningful state transitions: started, finished, the decision made. Sparse.
- `debug` — everything you might want while diagnosing, off in production.

A log at the wrong level trains people to ignore the right one. If everything is `error`,
nothing is.

## Log the decision points, not every line

At a boundary — a request in, a call out, a branch taken — log what was decided and the inputs
that decided it, with a correlation id that follows the request across services. You should be
able to trace one request end to end from the id alone.

## Never log a secret

No passwords, tokens, session ids, full card numbers, or personal data beyond what policy
allows. Redact at the point of logging, not by hoping a downstream filter catches it. A secret
in a log aggregator is a secret to rotate.

## Measure, do not just log

For anything with a latency or a rate, a metric answers "is it slow?" faster than a thousand
log lines. Logs explain *why*; metrics tell you *that* something is wrong in the first place.
