---
name: ci-cd
description: Write or repair CI/CD pipelines and workflow files. Use when a build fails in CI but not locally, when adding a workflow, or when caching, matrix, or deploy steps need design.
---

# CI/CD

CI is a second machine that does not have your setup. "Works on my machine" means the pipeline
is missing something your machine has.

## Reproduce the environment, not the symptom

When CI fails and local passes, the difference is the environment: the toolchain version, an
uncommitted file, a cache, an env var, the OS. Diff those before touching the code. Read the
failing log literally — the first error, not the last, which is usually a downstream echo.

## Pin everything that can move

- Toolchain versions (`node`, `bun`, `python`), action versions, base images. `latest`
  is a build that breaks on a day you did nothing.
- Lockfiles go in the repo and the install respects them (`--frozen-lockfile`, `ci`). An
  install that re-resolves in CI is a different build from the one you tested.

## Cache the expensive, deterministic part

Dependencies are the cache; build output usually is not. Key the cache on the lockfile hash so
a changed dependency invalidates it. A cache that is too broad serves stale artifacts; too
narrow saves nothing.

## Fail fast, in the right order

Cheap checks first: lint and typecheck before the test matrix, tests before the deploy. A
pipeline that deploys before it verifies publishes the bug it was built to catch.

## Secrets and deploys

Secrets live in the CI secret store, never in the file, and are masked in logs. A deploy step
is gated: on a tag, on a protected branch, on a manual approval — never on every push. Assume
every log line is public and write the pipeline accordingly.
