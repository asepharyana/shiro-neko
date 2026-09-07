---
name: deps
description: Manage dependencies: choosing, adding, updating, or removing them. Use when evaluating a library, resolving a version conflict, pruning unused deps, or hardening the supply chain.
---

# Dependencies

Every dependency is code you did not write but now maintain. Add deliberately, prune regularly.

## Choose on maintenance, not features

Before adding: is it actively maintained (recent commits, responsive issues), widely used, and
small enough to be worth it? A dependency that saves a day and is abandoned in a year costs a
week. For something small and stable, a dozen lines in your own codebase often beats a package.

## Pin and lock

Exact versions in the manifest for anything that matters, a lockfile committed, and installs
that respect it. A `^` range means your build tomorrow differs from your build today. The
lockfile is the build's memory; do not delete it to "fix" a conflict — resolve the conflict.

## Update on a schedule, read the changelog

Routine small updates beat a yearly painful one. For a major bump: read the changelog and the
migration guide, find every call site of the changed API, and apply one shape of change (see
the migrate skill). Update one thing at a time so a regression has an obvious cause.

## Know your transitive tree

A direct dependency drags in dozens of transitive ones. Audit the tree for: known
vulnerabilities (`audit`/SCA tooling), abandoned packages deep in it, and duplicate copies of
the same library at different versions bloating the bundle. Remove what you no longer use — an
unused dependency is attack surface and install time for nothing.

## Supply chain is a trust decision

A package runs its install scripts with your permissions. Prefer packages with provenance and a
reproducible build, be wary of sudden ownership transfers, and pin so a hijacked publish does
not reach you automatically. The lockfile is also your audit trail of exactly what shipped.
