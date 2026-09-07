---
name: docs
description: Write or update documentation, READMEs, and guides. Use when asked to document a feature, write usage docs, or bring docs back in line with the code.
---

# Documentation

Docs lie by omission. Write only what you have verified in the code.

## Ground every claim in the source

Before documenting a behaviour, read it. A flag, a default, an error message — open the
code and quote what it actually does, not what the name suggests. The most damaging doc
line is the confident one that was true two versions ago. If the code and the existing
docs disagree, the code is right; say so and fix the doc.

## Answer the reader's actual question

A reader opens a doc with a task, not a desire for completeness. Lead with the thing they
came to do, in the order they will do it:

- **A reference** lists what exists: every flag, every field, with its default and its type.
- **A guide** walks one path to one outcome. Resist documenting every branch — link instead.
- **A README** orients in sixty seconds: what it is, install, the first command that works.

## Show, then say

A working example beats a paragraph about one. Every command in the doc must be one you
ran, with its real output. A snippet that was never executed is a bug waiting for a reader.

## Match the house style

Read the neighbouring docs first: their heading depth, their code-fence language tags,
their tone. A doc that reads foreign is a doc nobody trusts enough to maintain.

## Keep it true over time

Document the stable contract, not the current implementation, unless the point is the
implementation. The fewer specifics a doc pins down, the less it rots.
