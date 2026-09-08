---
name: readme
description: Write or fix a project README. Use when creating a README, when a new user cannot get the project running from it, or when it has drifted from the code.
---

# README

A README has sixty seconds to answer: what is this, do I want it, and how do I run it. Everything
else is secondary to those three.

## The first screen answers three questions

1. **What it is** in one or two sentences, concrete about the problem it solves — not "a modern
   solution" but "a CLI that lints Terraform plans against your org's policies".
2. **Install** — the one command that gets it.
3. **The first thing that works** — the minimal command or snippet that produces visible output.
   If a new user cannot get a win in two minutes, most leave.

## Verify every command

Run each command in the README against a clean environment and paste its real output. The most
common README defect is an install or quickstart that no longer works because the code moved and
the doc did not. If you cannot run it, do not write it.

## Structure for scanning

After the quickstart, in the order a new user needs them: features as a short list of what it
does (not how), the common tasks as copy-paste examples, configuration as a table of options with
defaults, then links to deeper docs. Headings let a reader jump; a wall of prose gets skimmed
past the thing they needed.

## Show, do not tell

A three-line example of real use beats a paragraph describing capability. Show the input and the
output. A screenshot or asciinema of the actual tool running is worth a hundred adjectives —
include one if the tool has any visual surface.

## Keep it true

Document the stable interface, not this week's implementation, or the README rots. Re-read it on
every release: a README that contradicts the current version is worse than a short one, because
it actively misleads.
