# Extensions: auto-loaded skills, tools, and plugins

External extensions load automatically from two directories on every start, the project
shadowing the user by name:

| Origin | Directories |
|---|---|
| user | `~/.shiro-neko/skills` `~/.shiro-neko/tools` `~/.shiro-neko/plugins` |
| project | `.shiro/skills` `.shiro/tools` `.shiro/plugins` |

Drop a file in and it is live on the next start. No registry, no install command, no restart
of anything but the CLI itself.

**Everything here is data, never code.** That is the same rule the [registry](registry.md)
enforces, and it is the whole security model. An external extension can add instructions, a
bounded tool, or a refusal rule — it cannot run arbitrary code, so it cannot read every file
the agent can read or lie about what it blocks. A malformed file is reported on the welcome
dashboard and skipped, never fatal.

## Skills

A skill is a Markdown file with frontmatter, exactly like a bundled one:

```markdown
---
name: deploy
description: Ship a release. Use when asked to deploy or cut a release.
---

# Deploy

1. Confirm the tests pass. Do not deploy on a red suite.
2. Tag with the version from src/version.ts, not by hand.
```

Skills merge by name with the precedence `builtin < registry < user < project`, so your own
`debug.md` overrides the bundled `debug`. See [skills](skills.md) for the full format.

## Tools

A tool is a JSON manifest describing one bounded operation. Three kinds, each with a ceiling
on what it can do:

```json
{
  "name": "recent-changes",
  "description": "List the ten most recently changed files",
  "kind": "shell",
  "command": "git diff --name-only HEAD~10",
  "autoApprove": true
}
```

| Field | Meaning |
|---|---|
| `name` | The tool name the model calls. Letters, digits, dashes, underscores. |
| `description` | What the model reads to decide when to use it. |
| `kind` | `shell`, `http`, or `read`. |
| `command` | For `shell`: the template to run, with an optional `{arg}` placeholder. |
| `url` | For `http`: the URL to fetch, with an optional `{arg}` placeholder. HTTPS only. |
| `path` | For `read`: the workspace file to return, with an optional `{arg}` placeholder. |
| `autoApprove` | `false` to require approval before running. Default `true`. |

The model passes a single optional `arg` string, substituted into `{arg}`.

**The limits are the point.** A `shell` tool runs a fixed template through the **guard** and
the platform shell — the same chain a built-in `bash` call goes through, so an installed tool
cannot do what the agent itself may not. An `http` tool fetches one HTTPS URL. A `read` tool
returns one workspace file, jailed to the workspace. None of them executes code from the
manifest.

## Plugins

A plugin is a refusal manifest — the same shape the registry installs — a name, an optional
prompt appendix, and deny rules matched against tool input:

```json
{
  "name": "no-prod-config",
  "description": "refuses to edit production config",
  "appendix": "Production config is changed by hand, never by the agent.",
  "deny": [
    { "tools": ["write_file", "edit_file"], "pathPattern": "config/production", "reason": "production config is hand-edited" },
    { "tools": ["bash"], "commandPattern": "kubectl\\s+apply", "reason": "deploys to the cluster" }
  ]
}
```

A rule names the tools it covers and either a `pathPattern` (matched against the path a file
tool carries) or a `commandPattern` (matched against a `bash` command), both as case-insensitive
regexes, plus the `reason` handed to the model when it blocks. Patterns are validated on load;
an invalid regex is a reported error, not a crash.

Refusal plugins compose with the built-in [plugins](plugins.md) — the first block wins.

## Relationship to the registry

The [registry](registry.md) fetches the same kinds of files over HTTPS with a confirmation
step. Auto-load is for your own and your project's files, which need no confirmation because
you wrote them. The two mechanisms share the loaders and the safety model; they differ only in
where the file comes from.
