---
name: migrate
description: Upgrade a dependency, framework, or language version across a codebase. Use when a major version bump, a deprecation, or a breaking API change has to be applied.
---

# Migration

The failure mode is a half-applied migration: it compiles, most tests pass, and one code
path still uses the old API.

## Read the changelog before the code

Find what actually broke. A major version usually has a migration guide; read it and list
the changes that apply to this codebase specifically. Below 1.0, treat a minor bump as
breaking — semver promises nothing there.

## Find every call site before changing one

Grep for the old API across the whole repository, including tests, scripts, config, CI
workflows, Dockerfiles, and documentation. A version literal pinned in a workflow while the
manifest says something else is a split-brain deploy.

Write the list down with `todo_write`. The list is the migration; the edits are mechanical.

## Change in one shape

Apply the same transformation everywhere rather than improving each site as you pass
through it. A migration mixed with refactoring cannot be reviewed, and cannot be reverted
if the upgrade turns out to be wrong.

`apply_patch` is the tool for this: one atomic patch across the files that must land
together.

## Verify at the boundary that broke

Type checks catch signature changes and miss behaviour changes — the two ways a migration
actually breaks you. Run the tests, then actually *use* the thing that was upgraded: start
the server, run the CLI, execute the query, hit the endpoint. A green suite over an
untested upgrade path proves only that the suite did not cover it.

Pay special attention to silent behaviour changes: a default that flipped, a deprecated
call that still runs but does something subtly different, an error type that changed shape.
These compile, pass type checks, and still break production.

## Never hand-merge a lockfile

On a conflict, take either side whole and regenerate with the package manager. The resolver
owns that file; a hand-merge is a split-brain dependency tree that installs differently on
every machine.

## Report

The version before and after, every file class touched, what you verified by running, the
behaviour changes you checked by hand, and anything the changelog said applies that you
deliberately did not do — with the reason.
