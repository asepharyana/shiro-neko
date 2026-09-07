# Custom slash commands

A Markdown file becomes a slash command. Write the prompt once, run it with `/name` any time.

Two directories are scanned, the project shadowing the user by name:

| Origin | Directory |
|---|---|
| user | `~/.shiro-neko/commands/*.md` |
| project | `.shiro/commands/*.md` |

The filename is the command: `.shiro/commands/review-diff.md` becomes `/review-diff`. Names are
letters, digits, dashes, and underscores; anything else is skipped. A custom command can never
shadow a built-in — `/cost` always runs the built-in `/cost`.

## Format

```markdown
---
description: Review the staged diff for defects
agent: review
---

Review the staged changes. For each finding give file, line, what breaks, and the fix.
```

Frontmatter is optional but useful:

- **`description`** — the one line shown in the `/` menu. Without it the first body line is used.
- **`agent`** — run this command under a specific agent variant (`default`, `quick`, `deep`,
  `plan`, `review`). The variant is restored afterwards, so one command does not leak its agent
  into the rest of the session.

Everything after the frontmatter fence is the prompt. A file with an empty body is skipped, as
is one that fails to parse.

## Arguments

The body is a template, expanded against whatever you type after the command:

- `$ARGUMENTS` — the whole argument string.
- `$1`, `$2`, … — positional arguments. A missing positional expands to nothing.

```markdown
Compare $1 against $2 and report the differences. Context: $ARGUMENTS
```

`/compare src/a.ts src/b.ts` sends `Compare src/a.ts against src/b.ts … Context: src/a.ts src/b.ts`.

## Shell substitution

A `` !`command` `` inline runs the shell command and inlines its output before the prompt is
sent:

```markdown
Review this diff:

!`git diff --staged`
```

Every substitution runs through the **guard** before executing, exactly as a direct `bash` call
is — so a custom command cannot smuggle a destructive command past you. A substitution that
exits non-zero, or one the guard refuses, fails the command with the reason named.

## When to write one

- A prompt you find yourself retyping: a review shape, a release checklist, a project-specific
  "how we test".
- A prompt that should pin an agent: a read-only review command that always runs under `review`.
- Project conventions the whole team should share: commit `.shiro/commands/` so everyone gets
  the same commands.

For behaviour that must survive across sessions rather than be invoked on demand, use
[memory](memory.md). For instructions the agent loads by task rather than by name, use a
[skill](skills.md). For extensions that add tools or refusal rules rather than prompts, see
[extensions](extensions.md).
