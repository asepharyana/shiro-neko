---
name: review
description: Review a diff or a file for defects. Use when asked to review, critique, or check code before it ships.
---

# Code review

Severity order. Do not lead with style — a review that opens on naming while a real bug
sits three lines down has failed at its one job.

1. **Incorrect behaviour** — wrong result, wrong edge case, wrong state after failure.
2. **Missing validation at trust boundaries** — user input, network responses, file contents,
   anything crossing a process line. Internal calls need no defensive checks.
3. **Security** — injection, path traversal, secrets in logs or errors, missing authz.
4. **Resource handling** — unclosed handles, unbounded growth, unawaited promises.
5. **Clarity** — only when it will cause a future defect.

## How to read the change

- Read the diff against its intent. Does it actually do what the title/commit says? A
  correct-looking diff that solves the wrong problem is the most expensive approval.
- Read the *deleted* lines as carefully as the added ones. Behaviour is often lost in a
  removal, and diffs render deletions quietly.
- Follow each new call one level into the callee. The assumption that breaks it is usually
  one level down, invisible in the diff itself.

## For each finding

State file and line, the concrete failure (what input makes it break, or why it always
breaks), and the change. Show the fix as code when it is short. "This could be a problem"
without a path to a real input is noise; either trace it or drop it.

Order findings by severity and lead with the worst. Skip anything a formatter would fix.
Skip preference. If a choice is defensible, leave it — a review is not a place to impose
your style on code that works.

## Say when it is fine

A review that invents problems to look thorough is worse than a short one. If the change
is correct, say so plainly and stop. "Looks correct, and here is what I checked" is a
complete and useful review.

## Verify, do not assume

Read the surrounding code before calling something a bug. A "missing" null check often
exists one level up; a "redundant" guard often covers a caller you have not seen. Run the
tests or write the failing input if that is what settles it. A finding you verified is
worth ten you suspected.
