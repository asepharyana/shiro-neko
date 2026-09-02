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
shiro-neko 0.1.0-beta.1  openai/gpt-5  session 0193ab2c
agent: default  thinking: medium
cwd: /home/you/project
skills: debug, refactor, review, test
plugins: guard, time
approvals: on for write_file, edit_file, bash, mcp__*
/help for commands

> why does the pagination test fail?
```

## What it does

**Answers about your code, grounded in your code.** `grep` goes through ripgrep when it is
installed and honours `.gitignore`. `read_file` refuses binaries rather than filling the
context with mojibake.

**Edits with your approval.** Every `write_file`, `edit_file`, and `bash` call stops for a
`y`/`a`/`n` decision, with a coloured diff for edits. The `guard` plugin refuses
irreversible commands outright — `rm -rf`, `git reset --hard`, force pushes, `DROP TABLE` —
and `--yolo` cannot bypass it.

**Asks instead of guessing.** When a request has two readings that lead to different work,
the agent puts a question on screen with options.

**Delegates searches.** `task` spawns a read-only subagent whose findings come back as one
message, so a search across forty files does not fill the main context. Its progress
streams to a panel.

**Remembers between sessions.** Decisions, working commands, and traps go into per-project
memory that is injected at the start of every future session.

**Survives long tasks.** The task list and project memory live outside the message array,
so they survive both automatic pruning and `/compact`.

**Runs headless.** `shiro -p "review this diff" --json` for scripts and CI.

## Documentation

| Guide | Contents |
|---|---|
| [Configuration](docs/configuration.md) | config file, environment variables, every flag |
| [Tools](docs/tools.md) | every tool, the approval model, the guard |
| [Agents and thinking](docs/agents.md) | variants, thinking levels, read-only modes |
| [Skills](docs/skills.md) | the bundled skills and writing your own |
| [Plugins](docs/plugins.md) | the plugin interface and the builtins |
| [Memory and state](docs/memory.md) | memory, task lists, sessions, compaction |
| [MCP](docs/mcp.md) | connecting Model Context Protocol servers |
| [Headless mode](docs/headless.md) | `-p`, JSON events, exit codes, CI recipes |
| [Architecture](docs/architecture.md) | how the loop works and why it is built this way |
| [Development](docs/development.md) | building, testing, releasing |
| [Roadmap](ROADMAP.md) | what is next and what has been declined |
| [TODO](TODO.md) | the current work list |

## Commands

Type `/` and a menu appears, narrowing as you type.

```
/help  /agent [name]  /think [level]  /provider  /models  /model <id>
/skills  /plugins  /init  /context  /todos  /notes  /memory
/tools  /compact  /cost  /sessions  /resume <id>  /save  /clear  /exit
```

`esc` dismisses a panel or interrupts a running turn. Up and down recall earlier prompts.

## Status

Working: the agent loop, tool approvals, subagents, skills, plugins, per-project memory,
session persistence, MCP, markdown rendering, headless mode, five-platform builds.

Next up is in [TODO.md](TODO.md); the longer view and what has been declined are in
[ROADMAP.md](ROADMAP.md). The short version of what is missing: streaming reasoning display,
a message queue for prompts typed mid-turn, `@file` completion, and git-aware tools.

## License

MIT. See [LICENSE](LICENSE).
