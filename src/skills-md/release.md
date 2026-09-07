---
name: release
description: Cut a release: versioning, changelogs, tagging, publishing. Use when asked to release, bump a version, write release notes, or fix a broken publish.
---

# Release

A release is a promise that a specific, identified state of the code works. Make it
reproducible or do not make it.

## Version says what changed

Semver: breaking is a major, a feature is a minor, a fix is a patch. The number is a message to
whoever upgrades, not a marketing choice. Below 1.0, say so plainly — semver promises nothing
and the version should not pretend otherwise.

## The changelog is for the upgrader

- Group by what the reader must do: breaking changes and required actions first, then features,
  then fixes.
- Write it as "you can now X" or "Y no longer Z", from the user's side, not the commit's. A
  changelog that is a git log is a changelog nobody reads.
- Every breaking change names the migration: what to change to keep working.

## Verify before you tag

The release candidate builds clean from a fresh checkout, the tests pass, and the version string
in the source matches the tag you are about to push. A version/tag mismatch published is the
kind of thing that ships "0.4" labelled as "0.3" forever.

## Tag the commit, publish the artifact

Tag the exact commit that was verified, and build the artifact from that tag — not from a
working tree that has since moved. The tag is immutable; never move it to a different commit.
If a release is wrong, cut a new one with a new number; do not quietly re-tag.

## If it goes wrong

Have the rollback ready before you need it: the previous artifact still available, the deploy
reversible. A bad release is fixed forward with a patch release, not by deleting the evidence.
