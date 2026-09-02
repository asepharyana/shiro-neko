# Tools

## The approval model

Three categories.

**Free.** Read-only, no prompt: `read_file`, `glob`, `grep`, `task`.

**Session tools.** Also free, because they touch the agent's own state rather than your
files: `todo_write`, `remember`, `recall`, `forget`, `skill`, `ask`, and anything a plugin
marks auto-approved.

**Gated.** Every call stops for a decision: `write_file`, `edit_file`, `bash`, and every
`mcp__*` tool.

```
edit_file wants to run
src/users.ts +2 -1
   export function paginate(offset: number, total: number) {
 -   if (offset < total) return next();
 +   if (offset <= total) return next();
   }
y allow once | a always allow edit_file | n deny
```

`a` whitelists that tool for the rest of the session. `n` tells the model it was denied and
to ask what to do instead. `--yolo` skips all prompts.

**The guard runs before all of this.** It is not an approval — it is a refusal, and `--yolo`
does not reach it. See [plugins](plugins.md).

## File tools

### `read_file`

```
path    file path relative to the workspace root
offset  first line, 1-based
limit   max lines, default 2000
```

Returns contents with 1-based line numbers. Refuses binaries: a NUL byte in the first 8 KB
means the file is not text, and a model that reads a 90 MB executable has burned its whole
context on nothing.

### `write_file`

```
path     file path
content  full contents
```

New files and full rewrites only. Creates parent directories.

### `edit_file`

```
path        file path
oldString   exact text to find, whitespace and indentation included
newString   replacement
replaceAll  replace every occurrence instead of requiring exactly one
```

`oldString` must match byte-for-byte and appear exactly once unless `replaceAll` is set.
An ambiguous match is an error naming the count, which pushes the model to add surrounding
context rather than guessing which occurrence it meant.

### `glob`

```
pattern         e.g. "src/**/*.ts"
limit           max paths, default 200
includeIgnored  also return files git ignores
```

Walks the tree honouring `.gitignore` and `.shiroignore`, skipping `.git` and
`node_modules` unconditionally. Nested ignore files apply only within their own directory,
as git does. Returns posix paths relative to the workspace root.

### `grep`

```
pattern         regex source
include         glob limiting the search, default "**/*"
ignoreCase      case-insensitive
includeIgnored  also search files git ignores
```

Shells out to ripgrep when it is on PATH — roughly 15x faster on a real repo — and falls
back to a JavaScript walker otherwise. Output is `path:line: text` either way, so the model
sees one format regardless. Skips binaries. Caps at 200 hits.

### `bash`

```
command  shell command
timeout  ms, default 120000, max 600000
```

Runs in the workspace root through `bash -lc` or `cmd /c`. Output streams live to the panel
above the input rather than appearing all at once when the command exits — a two-minute test
run is otherwise indistinguishable from a hang. Both pipes are drained concurrently, since a
command that fills one while you block on the other deadlocks.

Returns exit code, stdout, stderr, and a note if a signal killed it.

## Agent tools

### `task`

```
description  short label shown to you
prompt       self-contained instructions
kind         "explore" (default) or "review"
```

Spawns a read-only subagent with `read_file`, `glob`, and `grep` only. It returns one
report, so the parent pays for findings rather than the whole search transcript. It sees
none of the parent conversation, so its prompt has to stand alone.

`explore` finds and reports. `review` critiques code in severity order. Progress streams to
the subagent panel.

### `ask`

```
question  one specific question
options   choices, recommendation first, each with an optional detail
multiple  allow more than one
```

Stops the turn and puts the question on screen. With options it is a picker; without, free
text. `esc` skips, which tells the model to decide and state its assumption.

Withheld entirely in headless mode — a question with no one to answer it would hang.

### `todo_write`

```
todos  the complete list: content, status, optional note
```

Statuses: `pending`, `in_progress`, `done`, `blocked`. Send the whole list each time; it
replaces the previous one. Warns when more than one task is `in_progress`, when nothing is
`in_progress` while work remains, or when a `blocked` task has no note.

### `remember`, `recall`, `forget`

Durable per-project notes. See [memory](memory.md).

### `skill`

```
name  skill name from the catalogue
```

Loads the body of a skill. See [skills](skills.md).

## Path safety

Every path a tool receives goes through a jail: resolved against the workspace root, then
checked that it did not escape. `../../etc/passwd` and absolute paths outside the root are
both refused before any filesystem call.

The model's output is a trust boundary. It can emit any string, so the check happens on
every call rather than being assumed.

## Output caps

Any single tool result is truncated at 30,000 characters with a note saying how much was
cut. `grep` stops at 200 hits, `glob` at 200 paths, `read_file` at 2000 lines by default.
Without caps one `grep` for `function` can end a session.
