# Tools

## The approval model

Three categories.

**Free.** Read-only, no prompt: `read_file`, `read_many_files`, `glob`, `grep`, `list_dir`,
`task`, and the whole git set.

**Session tools.** Also free, because they touch the agent's own state rather than your
files: `todo_write`, `remember`, `recall`, `forget`, `skill`, `ask`, and anything a plugin
marks auto-approved.

**Gated.** Every call stops for a decision: `write_file`, `edit_file`, `multi_edit`, `bash`,
and every `mcp__*` tool.

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

## Tool sets

Each tool costs roughly 550 characters of JSON schema on every request, and selection
accuracy drops as the list grows. Sets let you switch off what a project does not need:

| Set | Tools |
|---|---|
| `core` | `read_file` `write_file` `edit_file` `glob` `grep` `bash` |
| `edit-plus` | `multi_edit` `list_dir` `read_many_files` |
| `git` | `git_status` `git_diff` `git_log` `git_show` `git_blame` |

```json
{ "toolSets": ["edit-plus"] }
```

Omit `toolSets` for all of them. `core` is always on — without read, edit, and bash the
agent is not an agent. A disabled set reaches neither the wire nor the system prompt, since
a prompt that names an absent tool teaches the model to attempt calls that cannot succeed.
Session, plugin, and MCP tools are not part of this budget and are never gated here.

`/tools` shows which set each live tool came from.

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

### `read_many_files`

```
files  [{ path, offset?, limit? }], at most 20
```

One round trip for several files, each with its own window. Reads run concurrently and the
blocks come back in the order given, labelled:

```
===== src/app.ts =====
1: export const port = 8080;

===== src/gone.ts =====
[unreadable: No such file: src/gone.ts]
```

A path that cannot be read is reported in its own block rather than throwing, so one wrong
guess costs a line instead of the whole call. Numbering and binary refusal are the same code
path as `read_file`, so a batch read cannot drift from a single one.

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

### `multi_edit`

```
path   file path
edits  [{ oldString, newString, replaceAll? }], in the order to apply them
```

Several edits to one file in one call, one approval, one write. Each edit sees the result of
the previous one, so edits may build on each other.

Atomic: every edit is validated and applied in memory first, so a failure on the third edit
leaves the file exactly as it was rather than half-changed. The same uniqueness rule as
`edit_file` applies per edit, and the error names which edit failed.

### `list_dir`

```
path            directory, relative to the workspace root, default the root
depth           levels to descend, 1-6, default 2
includeIgnored  also show files git ignores
```

Tree view honouring `.gitignore`. Directories end with `/`, files show their size. Past the
depth limit the containing directory is still listed, so the shape of the tree stays visible
without its contents. Capped at 300 entries.

### `glob`

```
pattern         e.g. "src/**/*.ts"
limit           max paths, default 200
includeIgnored  also return files git ignores
```

Walks the tree honouring `.gitignore` and `.shiroignore`, skipping `.git` and
`node_modules` unconditionally. Nested ignore files apply only within their own directory,
as git does. Returns posix paths relative to the workspace root. A symlinked directory is
classified as a directory and not descended into, since it can point anywhere including
back into the tree.

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

**`ctrl-c` interrupts the command, not the turn.** The shell and everything it started are
killed — on Windows through `taskkill /T`, because killing `cmd` alone leaves the real command
holding both pipes open and the read never ends. The call then fails rather than returning,
so the model cannot mistake a killed command for one that ran and failed on its own:

```
The user interrupted this command. It did not finish, so its effects are unknown.
stdout:
[whatever it printed first]
```

The turn continues from there. `esc` still aborts everything, and `ctrl-c` with nothing
running quits as usual.

## Git tools

All five are read-only and therefore approval-free. Each spawns `git` with a fixed argument
array rather than a shell string, so an argument like `--author="; rm -rf /"` can only ever
be a literal argument — which is what makes auto-approval safe.

Output is described rather than raw porcelain: `git_status` names the branch and says
`staged modified` or `untracked` per file instead of leaving the model to decode two columns
of flags. Outside a repository they fail with `<cwd> is not a git repository.` rather than
passing git's own error text through.

```
git_status                                  branch, staged, modified, untracked
git_diff    staged?  path?                  unified diff of uncommitted changes
git_log     limit?   path?                  hash, date, author, subject; newest first
git_show    ref      path?                  one commit: message, author, diff
git_blame   path     startLine?  endLine?   who last changed each line
```

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
cut. `grep` stops at 200 hits, `glob` at 200 paths, `list_dir` at 300 entries,
`read_many_files` at 20 files, `read_file` at 2000 lines by default. Without caps one `grep`
for `function` can end a session.
