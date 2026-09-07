---
name: commit
description: Stage and commit work. Use when asked to commit, or to split existing changes into commits.
---

# Committing

Never commit unless the user asked. If it is unclear whether they did, ask. A commit is a
durable statement about shared history, not a save-point.

## Look before you stage

`git_status` and `git_diff` first — read the whole diff you are about to commit. You are
looking for three things:

1. **Changes that are not yours.** Another agent or the user may share this worktree, and
   `git add .` takes their half-finished work with yours.
2. **Files that should never be committed:** `.env`, credentials, keys, large build
   output, anything a `.gitignore` rule was supposed to catch and did not. Flag these to
   the user rather than committing them — a committed secret is a secret to rotate.
3. **Your own accidents:** debug prints, commented-out code, a stray `TODO`, a file you
   opened and saved by mistake. Revert them before staging, not in a follow-up commit.

Stage the specific paths you changed. `git add .` is how unrelated work ends up in a
commit that then has to be reverted whole.

## One commit, one reason

If the diff does two unrelated things, make two commits. A commit that both fixes a bug
and renames a module cannot be reverted, cherry-picked, or bisected usefully. Each commit
should pass the tests on its own — a series of broken commits defeats `git bisect`.

## The message

Match the repository's existing style — read `git_log` before writing one. Failing that:

- A subject line under 70 characters, imperative mood, saying what changed: "Fix off-by-one
  in pagination", not "fixed a bug" or "changes".
- A body explaining *why* when the reason is not obvious from the diff. Wrap at 72.
- No "as requested", no restating the diff line by line, no emoji unless the repo uses them,
  no sign-off noise the repo does not already use.

## Do not

- Do not `--amend` a commit that has been pushed. Write a new one.
- Do not `--no-verify`. If a hook rejects the commit, the hook found something — read it.
- Do not `git push` unless asked, and never force-push without being asked explicitly.
- Do not commit and then immediately fix it up with a second commit. Get it right, or say
  what is wrong.

## After committing

Report the short hash and the subject. If a hook rewrote files, say so, and confirm the
final state — `git_status` again — is what was intended.
