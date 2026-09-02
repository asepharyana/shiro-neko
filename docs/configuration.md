# Configuration

Settings come from three places. Later wins:

1. `~/.shiro-neko/config.json`
2. environment variables
3. command-line flags

## The config file

Written by `/provider`, editable by hand. Every field is optional.

```json
{
  "provider": "openai",
  "model": "gpt-5",
  "baseURL": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  "presetId": "openai",
  "agent": "default",
  "thinking": "medium",
  "maxRetries": 3,
  "plugins": ["guard", "time"],
  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
  }
}
```

| Field | Meaning |
|---|---|
| `provider` | wire protocol: `anthropic` or `openai`. Not the vendor — Groq, OpenRouter, and Ollama all speak `openai` |
| `model` | model id as the endpoint names it |
| `baseURL` | API root. Defaults to the official endpoint for the provider |
| `apiKey` | sent as `Authorization: Bearer` for `openai`, `x-api-key` for `anthropic` |
| `presetId` | which preset `/provider` chose, so it can show what is configured |
| `agent` | default variant: `default`, `quick`, `deep`, `plan`, `review` |
| `thinking` | default level: `off`, `low`, `medium`, `high`, `max` |
| `maxRetries` | retries per model call for transient failures. Default 3 |
| `plugins` | which plugins to enable. Omit for `["guard", "time"]` |
| `mcpServers` | see [MCP](mcp.md) |

## Provider presets

`/provider` offers these. Each sets `baseURL` and the wire protocol for you.

| Preset | Protocol | Endpoint |
|---|---|---|
| Anthropic | `anthropic` | `api.anthropic.com/v1` |
| OpenAI | `openai` | `api.openai.com/v1` |
| OpenRouter | `openai` | `openrouter.ai/api/v1` |
| Groq | `openai` | `api.groq.com/openai/v1` |
| DeepSeek | `openai` | `api.deepseek.com/v1` |
| xAI | `openai` | `api.x.ai/v1` |
| Ollama | `openai` | `localhost:11434/v1` |
| LM Studio | `openai` | `localhost:1234/v1` |
| Custom OpenAI-compatible | `openai` | you supply it |
| Custom Anthropic-compatible | `anthropic` | you supply it |

After the key is entered, `GET /v1/models` is called and the list becomes a picker. If the
endpoint does not implement it, you type the model id instead — the setup still completes.

## Environment variables

| Variable | Effect |
|---|---|
| `SHIRO_PROVIDER` | overrides `provider` |
| `SHIRO_MODEL` | overrides `model` |
| `SHIRO_BASE_URL` | overrides `baseURL` |
| `SHIRO_API_KEY` | overrides `apiKey` |
| `ANTHROPIC_API_KEY` | used when `provider` is `anthropic` and no key is set |
| `OPENAI_API_KEY` | used when `provider` is `openai` and no key is set |
| `SHIRO_HOME` | relocates config, sessions, memory, history, and user skills |
| `SHIRO_INSTALL_DIR` | where `install:local` and the installers put the binary |
| `SHIRO_REPO` | which GitHub repo the installers download from |
| `SHIRO_VERSION` | pins the version the installers fetch |

`SHIRO_HOME` is what the test suite uses to keep a run out of your real config.

## Flags

```
shiro [options]
shiro -p "prompt"          headless, prints to stdout
cat file | shiro -p        prompt read from stdin
```

| Flag | Effect |
|---|---|
| `-p`, `--print [prompt]` | headless mode. Needs `--yolo` for tool use |
| `--json` | with `-p`, one JSON event per line |
| `-c`, `--continue` | resume the newest session for this directory |
| `-r`, `--resume <id>` | resume by session id or unique prefix |
| `--agent <name>` | `default`, `quick`, `deep`, `plan`, `review` |
| `--think <level>` | `off`, `low`, `medium`, `high`, `max` |
| `--provider <name>` | `anthropic` or `openai` |
| `--model <id>` | model id |
| `--base-url <url>` | API root |
| `--no-mcp` | skip MCP servers |
| `--no-subagent` | omit the `task` tool |
| `--no-instructions` | ignore `AGENTS.md` and friends |
| `--no-skills` | ignore builtin and project skills |
| `--no-plugins` | disable all plugins, including the guard |
| `--no-memory` | do not load or write project memory |
| `--yolo` | skip every approval prompt |
| `-v`, `--version` | version, bun version, platform, source or compiled |
| `-h`, `--help` | usage |

## Where things live

```
~/.shiro-neko/
  config.json                 provider, model, key, defaults
  sessions/<uuid>.json        transcripts, token counts, cost, task list
  memory/<hash>.json          durable per-project notes
  history/<hash>.json         prompt history for up-arrow recall
  skills/*.md                 your own skills
```

Project files:

```
<project>/
  AGENTS.md                   instructions injected into the system prompt
  .shiro/skills/*.md          project skills, override user and builtin
  .shiroignore                extra ignore rules on top of .gitignore
```

Memory and history file names are SHA-256 prefixes of the absolute project path, because a
path is not a safe filename.

## OpenAI reasoning models

Newer OpenAI models reject function tools on `/v1/chat/completions` and require
`/v1/responses`. For `api.openai.com` both are chained: a 400, 404, 405, 415, 422, or 501
on the first switches to the second, sticks for the rest of the session, and prints one
notice. Retryable failures — 429 and 5xx — are left to the SDK's backoff instead.

Third-party endpoints get a plain chat-completions model with no fallback probe, since they
do not implement `/v1/responses`.
