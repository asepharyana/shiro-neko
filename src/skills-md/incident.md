---
name: incident
description: Respond to a production incident. Use when something is down, degraded, or misbehaving in production and must be diagnosed and mitigated under time pressure.
---

# Incident response

Mitigate first, diagnose second. Restore service, then find out why.

## Confirm and scope before touching anything

What is actually broken, for whom, since when? Check the signal, not the report: the dashboard,
the error rate, the health endpoint. A wrong scope sends you chasing a symptom. State the impact
plainly in one line before you start changing things.

## Recent change is the prime suspect

Most incidents follow a deploy, a config change, a flag flip, or a scaling event. What changed
in the window before it broke? Check the deploy log and the diff. The fastest fix is usually to
undo the last change, not to understand it.

## Mitigate, then understand

- Roll back the deploy, flip the flag off, fail over, scale up, restart the wedged process —
  whichever restores service fastest, even if you do not yet know the root cause.
- A mitigation you can reverse beats a perfect diagnosis that takes an hour. Note what you did so
  it can be undone or made permanent later.
- Do not deploy an unreviewed "fix" into the fire; it adds a second change to a system already
  misbehaving.

## Preserve evidence before it rotates away

Capture the logs, the error, the relevant metrics, a snapshot of the state — before a restart or
a rollback destroys it. You will want it for the postmortem, and it may be the only copy.

## Communicate and follow up

Say what is broken, what you are doing, and when the next update is — to whoever is affected,
in plain language, on a schedule. Afterwards: write the timeline, the root cause, and the
follow-ups that stop it recurring. An incident with no follow-up is a loan against the next one.
