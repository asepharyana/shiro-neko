# Undo

`/undo` reverts the most recent completed turn: it restores every file that turn
changed and rewinds the message history to the point before the turn began. It
can step back through up to 20 turns.

## How it works

Before a file-mutating tool (`write_file`, `edit_file`, `multi_edit`,
`apply_patch`) writes, it captures the current bytes of every file it is about
to touch. That snapshot is stored against the in-flight turn. When the turn
finishes (having changed at least one file and added at least one message), the
snapshots are pushed onto an undo log.

`/undo` pops the log and restores:

- a file that was edited — back to its prior contents;
- a file that was created — deleted;
- a file that was deleted — recreated with its prior contents;
- a move — the source restored and the moved copy removed.

Then it truncates the message history to the length it had when that turn
started, so the model no longer sees the reverted decisions.

## The honest limit

A `bash` command's effects cannot be snapshotted — a network call, a build
artifact, or a `git push` are not reversible by restoring file bytes. So `/undo`
covers file-tool edits (including `apply_patch` moves/deletes) and says so; it
does not pretend to reverse commands you ran via `bash`.
