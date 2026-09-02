# Memory and state

Four kinds of state, each with a different lifetime.

| State | Lives in | Survives |
|---|---|---|
| transcript | the message array | until compaction or `/clear` |
| task list | the system prompt, rebuilt each step | pruning and `/compact` |
| project memory | `~/.shiro-neko/memory/<hash>.json` | across sessions, forever |
| session record | `~/.shiro-neko/sessions/<uuid>.json` | until you delete it |

The split exists because compaction is destructive. `pruneMessages` deletes tool results and
`/compact` deletes the whole transcript, so anything recorded only in messages is lost
exactly when a long task needs it most.

## Project memory

Durable notes about the codebase, injected at the start of every session.

### `remember`

```
kind  fact | decision | gotcha | command
text  one self-contained line
```

- **fact** — how something is. "The API is versioned under `/v2`."
- **decision** — what was chosen and why. "We use snake_case for DB columns; the ORM
  expects it."
- **gotcha** — a trap. "The migration must run before the seed or the FK fails."
- **command** — an invocation that works. "Tests run with `bun test`, not `npm test`."

Duplicates are refused. Text is capped at 400 characters, the store at 300 entries.

### `recall`

Every term must appear. A match increments that entry's hit count, which protects it from
compaction later — an entry the agent actually uses is worth keeping verbatim.

### `forget`

Removes by substring, for a note that turned out wrong.

### What the agent sees

```
What you learned about this project in earlier sessions. Trust it, but verify anything
that contradicts what you can see in the code now:
- (command) tests run with bun test, not npm test
- (gotcha) the migration must run before the seed
- (decision) snake_case for DB columns, the ORM expects it
```

Top 20 by hit count, then recency. The "verify anything that contradicts" line matters:
memory goes stale and a confidently wrong note is worse than none.

### Compacting

`/memory` has the model merge entries. Two rules make it safe:

- Entries with at least one recall are kept verbatim and never merged.
- A model returning nothing parseable leaves the store untouched.

Without the second rule a bad response wipes everything the agent has learned.

`/notes` lists the store with hit counts. `--no-memory` disables loading and writing.

## Task list

`todo_write` replaces the whole list each call. Four states:

```
tasks ##########.............. 1/4  1 blocked
[x] read the pagination code
[~] fix the boundary
[ ] add a test
[!] update the docs  (no write access to the wiki)
```

`blocked` requires a note saying what is blocking it. The tool warns when more than one task
is `in_progress`, when nothing is `in_progress` while work remains, or when a `blocked` task
has no note.

The list is re-rendered into the system prompt on **every step**, not once per turn — a
`todo_write` on step one has to be visible to step two. It is saved with the session and
restored by `-c` or `/resume`.

`/todos` shows it. The panel above the input shows it live.

## Sessions

Every turn autosaves, debounced 400 ms so a long tool loop does not hit the disk each step.

```json
{
  "id": "0193ab2c-…",
  "createdAt": "…", "updatedAt": "…",
  "cwd": "/home/you/project",
  "provider": "openai", "model": "gpt-5",
  "title": "why does the pagination test fail?",
  "inputTokens": 48210, "outputTokens": 3105,
  "costUsd": 0.0913,
  "notebook": { "todos": [ … ] },
  "messages": [ … ]
}
```

```bash
shiro -c                  # newest session for this directory
shiro -r 0193ab2c         # by id or unique prefix
```

```
/sessions   list the last 15
/resume <id>
/save       write now instead of waiting for the debounce
```

A corrupt session file is skipped rather than crashing the list.

## Compaction

Two mechanisms.

**Automatic**, at roughly 120k estimated tokens: `pruneMessages` strips reasoning and older
tool calls from what goes on the wire. Local history is untouched, so the transcript on your
screen stays complete. The turn reports it:

```
context compacted: 192 messages pruned to 15 on the wire
```

**Manual**, `/compact`: the model writes a summary — goal, files touched, decisions, commands
and outcomes, what remains — and it replaces the transcript entirely.

### The pruning repair

`pruneMessages({ reasoning: 'all' })` strips a reasoning item and keeps the message item from
the same response. The OpenAI responses API treats the message as a dependent of that
reasoning item and rejects the request:

```
400 Item 'msg_…' of type 'message' was provided without its required 'reasoning' item: 'rs_…'
```

The two carry different ids, so they cannot be matched by id. What links them is the
assistant message they arrived in — one message is one response. `src/prune.ts` drops the
dependent parts of any turn whose reasoning was removed. That costs nothing, because pruning
was already discarding those turns.

## Prompt history

Per-directory, capped at 200, deduplicated against the previous entry. Up and down in the
input walk it; down past the newest restores what you were typing.

Stored at `~/.shiro-neko/history/<hash>.json`, where the hash is a SHA-256 prefix of the
project path.
