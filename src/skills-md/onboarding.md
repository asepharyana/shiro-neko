---
name: onboarding
description: Orient in an unfamiliar codebase. Use when dropped into a new project and asked to understand it, or when writing the docs that help a newcomer get productive.
---

# Onboarding to a codebase

Understand the running system before the source. The goal is a correct mental model, not to have
read every file.

## Get it running first

Build it, run it, run the tests. A project you can execute you can interrogate; one you have
only read you can only guess at. The README and the `package.json`/`Makefile` scripts tell you
the intended commands; if they do not work, that is your first finding.

## Trace one request end to end

Pick the central thing the system does and follow it: the entry point, the route or main, the
handler, the data out and back. One full path teaches you the architecture faster than reading
any single module. Note the layers you cross — that is the system's real structure.

## Read the structure, not the files

- The directory layout names the major components and their boundaries.
- The dependency manifest names the frameworks and the big choices already made.
- The tests show what the code is supposed to do, often better than the code does.
- `git log` on a core file shows what changes often and why — the living parts versus the
  stable ones.

## Map the seams

Where does data enter and leave (HTTP, a queue, a file)? Where is state kept (a database,
memory, a cache)? Where are the trust boundaries? Those are the places bugs and features both
live. You do not need to know every file; you need to know where a change of a given kind would
go.

## Ask the codebase, then a person

Grep and the outline/symbol tools answer most "where is X" faster than reading. When genuinely
stuck on *why* something exists — that is a question for a person or the history, not more
reading.
