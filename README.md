<p align="center">
    <img src="./assets/logo.png" height="300">
</p>

<h1 align="center">Shiro Neko</h1>

<p align="center">
    An agentic coding CLI. It reads your code, edits it, runs your tests, and asks when the
    request is ambiguous — in a terminal UI, with every mutating action gated behind an
    approval prompt.
</p>


## Install

A single prebuilt binary. No runtime, no `node_modules`.

```bash
# macOS, Linux
curl -fsSL https://raw.githubusercontent.com/zakirkun/shiro-neko/main/scripts/install.sh | sh

# Windows
irm https://raw.githubusercontent.com/zakirkun/shiro-neko/main/scripts/install.ps1 | iex
```

Both verify the download against the release checksums before installing. Builds are
published for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, and `windows-x64`.

Or from source:

```bash
git clone https://github.com/zakirkun/shiro-neko
cd shiro-neko
bun install
bun run install:local   # builds and puts `shiro` on PATH
```

## First run

```bash
shiro
```

With no API key configured it opens provider setup: pick an endpoint, paste a key, choose
from the models that endpoint actually reports. Settings land in
`~/.shiro-neko/config.json`. Run `/provider` any time to change them.

```
shiro-neko 0.1.0-beta.3  openai/gpt-5  session 0193ab2c
agent: default  thinking: medium
cwd: /home/you/project
skills: debug, refactor, review, test
plugins: guard, time
approvals: ask for write_file, edit_file, multi_edit, bash, mcp__*
/help for commands

> why does the pagination test fail?
```

## What it does

**Answers about your code, grounded in your code.** `grep` goes through ripgrep when it is
installed and honours `.gitignore`. `list_dir` gives an ignore-aware tree so it stops globbing
blindly to orient, and `read_many_files` pulls a batch in one round trip. `read_file` refuses
binaries rather than filling the context with mojibake.

**Edits with your approval, gated per command.** `write_file`, `edit_file`, `multi_edit`, and
`bash` stop for a `y`/`a`/`n` decision, with a coloured diff for edits. Rules match the command or
path rather than the tool, so `git *` can run unprompted while everything else still asks —
answering `a` whitelists that pattern, not the whole tool. `.env` and `.pem` files are refused on
read outright. The `guard` plugin refuses irreversible commands ahead of any of it — `rm -rf`,
`git reset --hard`, force pushes, `DROP TABLE` — and `--yolo` cannot bypass it.

**Shows its work.** Reasoning streams to a collapsed panel you can expand with `ctrl-r`, the
tool in flight is named as it runs, and `bash` output streams live instead of arriving all at
once when the command exits. `ctrl-c` kills a runaway command without ending the turn.

**Takes prompts while it works.** Type during a turn and it queues; the queue drains in order
when the turn ends. `esc` interrupts and clears it. `@` completes workspace paths.

**Reads git without touching it.** `git_status`, `git_diff`, `git_log`, `git_show`, and
`git_blame` are approval-free, because they spawn git with a fixed argument list and cannot
mutate anything.

**Asks instead of guessing.** When a request has two readings that lead to different work,
the agent puts a question on screen with options.

**Delegates searches.** `task` spawns a read-only subagent whose findings come back as one
message, so a search across forty files does not fill the main context. Its progress
streams to a panel.

**Extensible from the prompt.** `/registry` browses external skills and plugins and installs
them with one confirmation. A skill is shown in full before its text joins your system prompt;
a plugin is a manifest of refusal rules, never code.

**Remembers between sessions.** Decisions, working commands, and traps go into per-project
memory that is injected at the start of every future session.

**Survives long tasks.** The task list and project memory live outside the message array,
so they survive both automatic pruning and `/compact`.

**Runs headless.** `shiro -p "review this diff" --json` for scripts and CI.

**Keeps the tool list affordable.** Fourteen built-in tools, grouped into sets. Each costs
about 550 characters of schema on every request, so `{ "toolSets": [] }` trims back to the six
core ones and a disabled set reaches neither the wire nor the prompt.

## Documentation

Start with whichever question you have. Each guide says what it decided and why, not just what
the flags are.

| Guide | Contents |
|---|---|
| [Configuration](docs/configuration.md) | config file, provider presets, environment, every flag |
| [Tools](docs/tools.md) | every tool, tool sets and what they cost, the approval model |
| [Permissions](docs/permissions.md) | allow/ask/deny rules, patterns, defaults, the repeat guard |
| [Agents and thinking](docs/agents.md) | variants, thinking levels, step caps, which to reach for |
| [Skills](docs/skills.md) | the bundled skills, writing your own, why the catalogue is split |
| [Plugins](docs/plugins.md) | the interface, the guard and its limits, builtin versus installed |
| [Registry](docs/registry.md) | installing external skills and plugins, publishing your own |
| [Memory and state](docs/memory.md) | memory, task lists, sessions, compaction and its repair |
| [MCP](docs/mcp.md) | connecting servers, namespacing, cost, debugging one |
| [Headless mode](docs/headless.md) | `-p`, JSON events, exit codes, CI recipes |
| [Architecture](docs/architecture.md) | how the loop works and why it is built this way |
| [Development](docs/development.md) | building, testing, adding a tool, releasing |
| [Roadmap](ROADMAP.md) | what is next and what has been declined |
| [TODO](TODO.md) | the current work list, with known rough edges |

## Commands

Type `/` and a menu appears, narrowing as you type.

```
/help  /agent [name]  /think [level]  /provider  /models  /model <id>
/skills  /plugins  /registry [search|add|remove]  /init  /context
/todos  /notes  /memory  /tools  /compact  /cost
/sessions  /resume <id>  /save  /clear  /exit
```

`esc` dismisses a panel, interrupts a running turn, and clears the queue. `ctrl-c` kills the
running command but keeps the turn. `ctrl-r` expands the reasoning panel. `@` completes a
workspace path. Up and down recall earlier prompts.

## Status

Working: the agent loop, tool approvals, subagents, skills, plugins, per-project memory,
session persistence, MCP, markdown rendering, headless mode, five-platform builds, streaming
reasoning display, the mid-turn prompt queue, gateable tool sets, read-only git tools, batch
reads, `@file` completion, interruptible commands, and the external registry.

Next up is in [TODO.md](TODO.md); the longer view and what has been declined are in
[ROADMAP.md](ROADMAP.md). The short version of what is missing: a summary of what compaction
discarded, `web_fetch`, a spend ceiling, and a cheaper model for subagent searches.

## License

MIT. See [LICENSE](LICENSE).
