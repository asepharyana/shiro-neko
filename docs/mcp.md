# MCP

Model Context Protocol servers contribute tools to the agent. Two transports: a local
command over stdio, and a remote http or sse endpoint.

## Adding one from the prompt

```
/mcp              list what is configured, with the tool count (or "lazy") each contributed
/mcp add          wizard: local or remote, then the fields that kind needs
/mcp remove <name>
```

`/mcp add` asks for the kind first, because the two need different fields — a command and
its arguments against a URL and its headers — and a single form with half of it inapplicable
is worse than two short ones.

```
Add an MCP server
none configured yet
> local    a command on this machine, over stdio
  remote   an http or sse endpoint
```

The name is validated as it is typed. Tools register as `mcp__<server>__<tool>`, so a name
with a space or a double underscore produces a tool the model cannot address and two servers
whose namespaces can collide — both are refused in place rather than at connect time. A name
already in the config is refused too.

For a local server the wizard then asks for the command and its arguments; arguments split on
spaces and keep quoted runs together, so `--root "/home/my folder"` arrives as one argument.
For a remote one it asks for the URL — http or https only — and optional headers as
`KEY: value, OTHER: value`.

Both write straight to `config.json` and merge with whatever is already there. **A new server
connects on the next start**, not mid-session: connecting during a turn would change the tool
list under a request that is already running.

`/mcp` shows the state of each configured server, which is what makes a typo visible:

```
mcp servers
/mcp add to add one

- `filesystem` (local) - connected (lazy)
  npx -y @modelcontextprotocol/server-filesystem .
- `api` (remote) - failed: fetch failed
  https://example.com/mcp

configured in /home/you/.shiro-neko/config.json
```

Under `eager` the same list shows a tool count instead of `(lazy)`, because every server's tools
are registered up front.

## The config file

The wizard writes this; it is equally editable by hand.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "api": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer sk-..." }
    }
  }
}
```

| Field | Kind | Meaning |
|---|---|---|
| `command` | local | the executable to spawn |
| `args` | local | its arguments |
| `env` | local | extra environment variables |
| `cwd` | local | working directory |
| `url` | remote | the MCP endpoint |
| `type` | remote | `http` (default) or `sse` |
| `headers` | remote | sent with every request, for auth |

`--no-mcp` skips every server for one run, which is the first thing to try when the agent is
behaving oddly and a server is in play.

[Model Context Protocol](https://modelcontextprotocol.io) servers contribute tools. Configure
them in `~/.shiro-neko/config.json` and they appear alongside the builtins.

## Configuration

Everything the wizard writes is equally editable by hand, and a hand-written entry that
`/mcp add` would have rejected still connects — the validation is on the input path, not a
schema check at load.

```json
{
  "mcpMode": "eager",
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
at startup and closed on exit. `env` is merged over the inherited environment, so a server
inherits your `PATH` unless you replace it.

**Remote** servers take `url`, and optionally `type` (`http` or `sse`, default `http`) and
`headers`.

A sibling key, `"mcpMode"`, picks how the configured servers' tools reach the model: `lazy`
(the default) or `eager`. It is hand-edited — the `/mcp add` wizard does not set it — and applies
to every server, so it lives beside `mcpServers`, not inside one.

A token in `headers` sits in `config.json` in plain text, same as `apiKey`. For anything beyond
a local dev token, prefer a stdio server that reads its own credential from the environment.

## Startup cost

Servers connect **in parallel**, so the slowest one sets how long startup takes rather than the
sum of them. `npx -y some-server` re-resolves the package on each launch; installing it and
calling the binary directly is usually the difference between a noticeable wait and none.

`--no-mcp` skips them all, which is also the quickest way to tell whether a slow start is MCP
or something else.

## How a server's tools reach the model

Two modes, switched with `"mcpMode"` in config. **`lazy` is the default**; `eager` is the opt-in.

- **Lazy** registers three meta-tools — `mcp_list`, `mcp_inspect`, `mcp_call` — instead of one
  schema per server tool. The server's real tools are fetched only when `mcp_call` actually
  invokes one, so a server exposing twenty tools costs almost nothing until one is used. This
  is why the affordability paragraph in the README says a configured server no longer taxes
  every request.
- **Eager** registers every server tool up front as in the old 1.0 behaviour. If a server
  exposes only two tools, eager is cheaper because there is no list-then-inspect round trip.

The model is told the connected server names through the meta-tool descriptions and a prompt
line, then discovers each tool's schema on demand:

```
- mcp_list, mcp_inspect, mcp_call: MCP tools are fetched on demand. mcp_list names a
  server's tools, mcp_inspect reads one tool's schema, mcp_call runs it. Never guess a
  server or tool name: list first.
```

A `mcp_call` still routes through the same permission rules and guard as a built-in, so the
lazy path is not a way around approval.

## Naming

In `lazy` mode (the default) tools are addressed as `mcp_call(server, toolName, args)`; the
server names are zero-ambiguity identifiers you list first. In `eager` mode tools arrive as
`mcp__<server>__<tool>`: a server named `fs` exposing `read_file` becomes `mcp__fs__read_file`.

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
shiro-neko 0.1.0-beta.5  openai/gpt-5  session 0193ab2c
mcp: 4 tools
mcp db failed: spawn python ENOENT
```

Nothing else is lost — the other servers still load, the builtins still work. A missing
Python interpreter should not stop you from editing a file.

`--no-mcp` skips them all.

## Inspecting

`/tools` lists everything offered this turn. In `eager` mode that includes each MCP tool, named
`mcp__<server>__<tool>`, described with whatever the server sent. In `lazy` mode the three
meta-tools appear and the server's real tools are surfaced by `mcp_list` inside the session.

Into `mcp_inspect` or `mcp_list` goes the server name, not an `mcp__` path, so the prompt tells
the model which servers are connected and to list first before guessing a tool name.

## Cost

In **lazy** mode (the default) a configured server contributes three small meta-tool schemas to
every request, not one schema per tool. A server exposing twenty tools therefore costs a few
hundred tokens per turn rather than roughly 2,750, and it stays cheap whether the model uses
the tools or not. Browsing a server's tools and reading a schema still brings that server's
schema into view one tool at a time, but only when the model asks for it.

In **eager** mode each tool adds its name, description, and JSON schema to every request, and
that cost is sent whether or not the model uses any of them. That is the right trade only for a
server with one or two tools, which is why eager exists.

MCP tools are **not** covered by `toolSets` in either mode — that budget only governs the
built-ins. There is no per-server switch beyond the global `mcpMode`, so choosing `eager` turns
every server eager; a server exposing many tools you never use is worth finding a narrower one
for.

`/tools` shows the count both ways:

```
tools
26 offered this turn of 26 registered
```

A gap between the two numbers means a tool set or a read-only agent variant is withholding
something. MCP tools never appear in that gap.

## Writing a server

Any MCP-compliant server works. A minimal stdio one needs three methods: `initialize`,
`tools/list`, and `tools/call`. The test suite includes one at
`test/fixtures/mcp-stub.ts` — about 50 lines, and useful as a starting point.

The suite runs it as a **real subprocess** rather than mocking the transport, because the parts
that break in practice are the handshake and the framing, and a mock asserts neither.

## Debugging a server

A server that starts but returns nothing useful is the harder case. In order of speed:

1. `/tools` — did the tools arrive at all? A server with no tools is a `tools/list` problem.
2. `shiro -p "run mcp_call(server, \"api\", \"query\", {...}) with ..." --json --yolo` — the
   exact `tool-call` input and `tool-result` output, one JSON object per line. In eager mode the
   address is `mcp__<server>__<tool>` instead.
3. Run the server by hand: `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | your-server`.
   If that is wrong, nothing above it can be right.

For an HTTP server, `curl -X POST $URL -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`
answers the same question without shiro in the way.
