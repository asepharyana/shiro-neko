# Plugins

A plugin extends the agent in four ways: it can add tools, mark tools auto-approved, block
a tool call before it runs, and append to the system prompt. It can also run something after
each turn.

Plugins are compiled into the binary. Loading them from disk is deliberately not supported
yet — see [ROADMAP.md](../ROADMAP.md).

## Enabling

```json
{ "plugins": ["guard", "time"] }
```

That is also the default when the field is absent. `--no-plugins` disables all of them,
including the guard. `/plugins` lists what is active and reports any name that did not
resolve.

## The interface

```ts
export type Plugin = {
  name: string;
  description: string;
  tools?: ToolSet;
  autoApprove?: readonly string[];
  beforeToolCall?: (ctx: { toolName: string; input: unknown; cwd: string }) => string | undefined | Promise<string | undefined>;
  afterTurn?: () => void | Promise<void>;
  appendix?: string;
};
```

`beforeToolCall` returning a string **blocks** the call, and the string is given to the model
as the reason. Returning `undefined` allows it.

Two decisions worth knowing about:

**A throwing hook blocks.** A guard that crashes must fail closed. Treating an exception as
"allow" would mean a bug in a security plugin silently disables it.

**Blocks are checked before approval.** `--yolo` skips prompts; it does not skip guards. A
plugin block is a refusal, not a permission question.

**A guard sees `bash` before the command runs, not while it runs.** The guard is the only thing
that can refuse a command outright; once one is running, `ctrl-c` is what stops it. Both matter:
a pattern the guard does not know about is still interruptible by hand.

## Builtins

### `guard` (default on)

Refuses irreversible shell commands outright. Approval alone is a weak defence here: a user
holding `a` through a batch of edits will approve one of these without reading it.

| Pattern | Why |
|---|---|
| `rm -rf`, `rm -f` | recursive or forced delete |
| `git reset --hard` | discards uncommitted work |
| `git clean -f` | deletes untracked files |
| `git push --force`, `-f` | rewrites remote history |
| `git branch -D` | deletes a branch without a merge check |
| `DROP TABLE`, `TRUNCATE` | destroys database data |
| `mkfs`, `dd of=/dev/…` | writes to a raw device |
| `chmod 777` | makes files world-writable |
| `shutdown`, `reboot`, `halt` | affects the whole machine |
| `:(){ :\|:& };:` | fork bomb |
| `curl … \| sh`, `wget … \| sh` | pipes a download into a shell |

```
Blocked by the guard plugin: refusing "rm -rf build" (recursive or forced delete).
Ask the user to run it themselves if it is really needed.
```

The model is told to relay the command rather than work around it. `rm build/one-file.js`,
`git push origin feature`, and `git commit` all pass — the patterns target irreversibility,
not the commands themselves.

### `time` (default on)

Adds `current_time`, returning ISO 8601 plus the local string. Auto-approved; it reads
nothing. Useful because models are confidently wrong about the date.

### `bell` (opt in)

Writes `\u0007` to stderr when a turn ends. Off by default — a bell after every turn is
intrusive, but it is genuinely useful when a turn takes minutes.

```json
{ "plugins": ["guard", "time", "bell"] }
```

## Writing one

Plugins live in `src/plugins-builtin.ts` and are registered in `BUILTIN_PLUGINS`.

```ts
export const noSecretsPlugin: Plugin = {
  name: 'no-secrets',
  description: 'refuses to write files that look like credentials',
  appendix:
    'The no-secrets plugin refuses writes to .env and credential files. Ask the user to ' +
    'add secrets themselves rather than working around it.',
  beforeToolCall: ({ toolName, input }) => {
    if (toolName !== 'write_file' && toolName !== 'edit_file' && toolName !== 'multi_edit') return undefined;
    const path = String((input as { path?: unknown } | null)?.path ?? '');
    if (/(^|\/)\.env|credentials|\.pem$/.test(path)) {
      return `refusing to write ${path}; add secrets yourself`;
    }
    return undefined;
  },
};
```

Then add it to `BUILTIN_PLUGINS` and, if it should be on by default, `DEFAULT_ENABLED`.

Note the three tool names. Every write tool has to be listed, and `multi_edit` is easy to miss
— a guard that only checks `write_file` and `edit_file` is bypassed by a batch edit.

Write the `appendix` whenever the plugin can block something. Without it the model hits a
refusal it was never told about and tries to route around it.

## Ordering

Plugins run in the order they are enabled. The first `beforeToolCall` to block wins;
later hooks are not consulted. `afterTurn` runs every hook, and one throwing does not stop
the rest.
