---
name: security
description: Review code for security defects, or write code that handles untrusted input. Use when touching authentication, user input, file paths, shell commands, SQL, or anything reachable from the network.
---

# Security

Find the trust boundary first. Everything crossing it is hostile until parsed.

## The boundaries in most codebases

- Request bodies, query strings, headers, cookies.
- File contents and filenames, including paths a user supplied.
- Environment variables in a multi-tenant deployment.
- Anything a model or a third-party API returned.

Inside a boundary, values are already validated and re-checking them is noise. At the
boundary, nothing is optional.

## What to look for, in order

1. **Injection.** String-built SQL, shell commands assembled from input, `eval`, template
   rendering with user data as the template rather than the data. The fix is parameters and
   argument arrays, never escaping.
2. **Missing authorisation.** An endpoint that checks *who* you are but not *what* you may
   touch. Look for an id taken from the request and used without an ownership check.
3. **Path traversal.** `../` in anything joined onto a filesystem root. Resolve, then verify
   the result is still inside the root — a prefix check on the raw input misses
   `a/../../secret`.
4. **Secrets in the wrong place.** Keys in source, in logs, in error messages, in a commit.
   A secret that reached a log is a secret to rotate.
5. **Server-side request forgery.** A URL from input, fetched. Block private and loopback
   addresses by *resolved* address, and re-check every redirect hop.
6. **Weak crypto and hand-rolled auth.** Homemade token formats, `Math.random` for anything
   security-bearing, comparisons on secrets that are not constant time.

## Verify the path before reporting

Trace each candidate from an attacker-controlled value to the sink before you name it. A
"this could be unsafe" without that path is noise that buries the real finding. If you
cannot construct the malicious input that reaches the sink, either keep looking or say
plainly that you could not confirm it.

Do not fix a symptom at one caller when the sink is shared. Grep every caller and fix the
seam once — a sanitiser at one of five call sites is four open holes and one false sense
of safety.

## Reporting

File, line, the path from input to sink, a concrete payload, and the fix. Rank by
exploitability: a reachable injection beats a theoretical weakness in dead code. Say
plainly when a thing that looks dangerous is actually fine, and why — a reviewer's
confidence in the clean parts is worth as much as a finding.
