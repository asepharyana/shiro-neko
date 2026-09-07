---
name: git-workflow
description: Work with branches, rebases, merges, and history. Use when untangling a branch, preparing a PR, deciding rebase vs merge, or recovering from a git mistake.
---

# Git workflow

History is a communication tool. Write it for the person who reads it in six months — usually you.

## One branch, one purpose

A branch that does two things produces a PR that can only be reviewed as all-or-nothing and
reverted only whole. Keep it small and single-purpose; open the second thing as its own branch.

## Rebase to clean up, merge to preserve

- Rebase your own unpushed work freely: it makes a linear, readable history.
- Never rebase a branch others have pulled — it rewrites commits they have, and the next pull
  becomes a mess. Merge shared branches instead.
- Interactive rebase before opening the PR: squash the "fix typo" and "wip" commits into the
  change they belong to. The PR should read as a series of intentional steps, not a diary.

## Recover without panic

- `git reflog` finds almost anything you "lost": the branch you deleted, the commit you reset
  away. Nothing committed is truly gone for ~30 days.
- A bad merge: `git merge --abort`. A bad rebase: `git rebase --abort`. Both stop cleanly
  rather than pushing forward into a worse state.
- Committed to the wrong branch: `git reset --soft` to keep the work, switch, recommit.

## The commit message is the review's first page

Subject under 70 chars, imperative, says what changed. Body explains *why* when it is not
obvious. A reviewer who cannot tell why a change exists from its message will ask, or worse,
approve without understanding.

## Read the conflict, do not guess

On a conflict, open the file and understand both sides before resolving. Taking "ours" or
"theirs" wholesale because it is faster is how a resolved conflict silently drops someone's
work.
