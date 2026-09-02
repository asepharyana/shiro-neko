# MCP

[Model Context Protocol](https://modelcontextprotocol.io) servers contribute tools. Configure
them in `~/.shiro-neko/config.json` and they appear alongside the builtins.

## Configuration

```json
{
  "mcpServers": {
    "fs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "db": {
      "command": "python",
      "args": ["-m", "my_mcp_server"],
      "env": { "DATABASE_URL": "postgres://localhost/dev" },
      "cwd": "/home/you/tools"
    },
    "api": {
      "url": "http://localhost:3000/mcp",
      "type": "http",
      "headers": { "Authorization": "Bearer local-dev-token" }
    }
  }
}
```

**stdio** servers take `command`, and optionally `args`, `env`, `cwd`. The process is spawned
at startup and closed on exit.

**Remote** servers take `url`, and optionally `type` (`http` or `sse`, default `http`) and
`headers`.

## Naming

Tools arrive as `mcp__<server>__<tool>`. A server named `fs` exposing `read_file` becomes
`mcp__fs__read_file`.

The namespace is not cosmetic. Two servers both exposing `search` would otherwise silently
shadow each other, and the model would call one believing it was the other.

## Approval

**Every MCP tool requires approval on every call.** They are third-party code with unknown
side effects, so they are treated like `bash` rather than like `read_file`. `a` whitelists
one tool for the session.

`--yolo` skips these prompts, as it does for the builtins. Plugin guards still apply.

## Failure handling

A server that fails to start is reported and the session continues:

```
shiro-neko 0.1.0-beta.3  openai/gpt-5  session 0193ab2c
mcp: 4 tools
mcp db failed: spawn python ENOENT
```

Nothing else is lost — the other servers still load, the builtins still work. A missing
Python interpreter should not stop you from editing a file.

`--no-mcp` skips them all.

## Inspecting

`/tools` lists everything offered this turn, MCP tools included. The system prompt describes
them as a group:

```
- mcp__api__query, mcp__fs__read_file: from MCP servers, named mcp__<server>__<tool>.
  Each needs approval; read its own description before calling.
```

Their individual descriptions come from the server, so that is what the model reads before
calling one.

## Cost

Each tool adds roughly 550 characters of schema to every request. A server exposing twenty
tools costs about 2,750 tokens per turn, sent whether or not the model uses any of them.

Prefer servers with a focused tool set. If one exposes many tools you never use, it is worth
finding a narrower server or writing one.

## Writing a server

Any MCP-compliant server works. A minimal stdio one needs three methods: `initialize`,
`tools/list`, and `tools/call`. The test suite includes one at
`test/fixtures/mcp-stub.ts` — about 50 lines, and useful as a starting point.
