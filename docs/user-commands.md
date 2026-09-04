# User commands

Define your own slash commands in a markdown file: `.shiro/commands.md` at the
workspace root. Each command is a `## <name>` heading; an optional `> summary`
line under it becomes the `/`-menu description; the body is the prompt template
sent to the model.

```markdown
# My commands

## review
> review a change against the project rules

Read @AGENTS.md first, then critique:
$ARGUMENTS

## scaffold
> make a new module

Create a module named $1 in src/, with a test.
```

The body supports these substitutions:

- `$ARGUMENTS` — everything typed after the command name, verbatim.
- `$1` .. `$9` — the nth whitespace-separated argument (empty when absent).
- `` !`cmd` `` — replaced with the trimmed stdout of running `cmd` in a shell.
- `@path` — replaced with the contents of the file at `path` (workspace-rooted).

Substitutions apply in a safe order: shell reads first, then files, then `$n`
tags, so text a shell call produces is not itself re-read. A missing file or
failing shell keeps its literal text plus a bracketed note rather than throwing.

A user command whose name collides with a built-in is shadowed — the built-in
wins — so a project cannot hijack `/model` or `/help`. Type `/name` to run one;
it is also listed in the `/` completion menu.
