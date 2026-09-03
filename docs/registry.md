# Registry

External skills and plugins, browsed and installed from the CLI.

```
/registry                     everything in the index
/registry search <query>      narrow by name or description
/registry installed           what is already here
/registry add <name>          fetch, show, then install on confirmation
/registry remove <name>       delete an installed entry
```

```
registry
3 of 3 available
S migration    Write or run a database migration
S commit-style Write commits the way this team does
P no-secrets   Refuses writes to credential files  installed
S skill  P plugin  |  /registry add <name>
```

`esc` dismisses the panel.

## The two kinds are not equally safe

**A skill is instructions.** Installing one puts a stranger's words into the system prompt of
every future session in this project. That is prompt injection by invitation, so the install
shows the body first and `/skills` always says the origin:

```
install skill "migration"?
https://raw.githubusercontent.com/example/registry/main/skills/migration.md

  Migrations live in `db/migrations/` and are timestamped, never renumbered.

  Run `bun run db:migrate` locally first. Staging runs them on deploy.

A skill is instructions the agent follows. This text joins your system prompt.
y install | n cancel
```

**A plugin is data.** Never code. A manifest declares refusal rules; the guard that evaluates
them is the same compiled code for every installed plugin:

```json
{
  "name": "no-secrets",
  "description": "Refuses writes to credential files",
  "appendix": "The no-secrets plugin refuses writes to .env and credential files.",
  "deny": [
    {
      "tools": ["write_file", "edit_file", "multi_edit"],
      "pathPattern": "(^|/)\\.env|credentials|\\.pem$",
      "reason": "refusing to write a credential file; add secrets yourself"
    }
  ]
}
```

Loading TypeScript from a URL is not offered at any price. A plugin can block tool calls, so
one that could also execute could read every file the agent can read and lie about blocking
anything. See [plugins](plugins.md) for why this boundary exists.

## What is validated before anything is written

| Check | Why |
|---|---|
| `https` only, `localhost` for tests | `file:` would read a local path, `data:` would inline a payload |
| Name matches `^[a-z0-9][a-z0-9-]*$` | the name becomes a filename, so `../evil` must not parse |
| Index at most 256 KB, body at most 64 KB | a hostile index should not exhaust memory |
| Manifest against a strict schema | extra keys like `beforeToolCall` are dropped, not honoured |
| Every pattern compiles as a regex | a broken pattern would fail on the first tool call instead |
| Pattern at most 200 characters | it runs on every tool call; a pathological one is a denial of service |
| Body name matches the index name | an index entry cannot serve something else under a trusted name |
| At least one deny rule | a plugin with no rules is only prompt text, which is what a skill is for |

A malformed installed plugin is reported by `/plugins` and skipped. One bad install does not
stop the agent from starting.

## Where installs land

```
~/.shiro-neko/registry/
  skills/<name>.md      loaded as origin "registry"
  plugins/<name>.json   loaded as a declarative plugin
```

Precedence for skills, low to high: **builtin → registry → user → project**. A skill you wrote
in `~/.shiro-neko/skills/` or `.shiro/skills/` always beats one fetched from a registry, so an
install can never silently shadow your own work.

Installs take effect on the next start. A skill joins the system prompt and a plugin joins the
guard chain, and both are assembled once at boot; hot-swapping either mid-session would mean a
turn whose rules changed underneath it.

## Pointing at your own index

```json
{ "registryUrl": "https://example.com/my-registry/index.json" }
```

The index is one JSON document:

```json
{
  "skills": [
    {
      "name": "migration",
      "description": "Write or run a database migration",
      "url": "https://example.com/skills/migration.md",
      "author": "you"
    }
  ],
  "plugins": [
    {
      "name": "no-secrets",
      "description": "Refuses writes to credential files",
      "url": "https://example.com/plugins/no-secrets.json"
    }
  ]
}
```

Both arrays are optional. A name may appear once as a skill and once as a plugin; `/registry
add skill:review` disambiguates, and an ambiguous name is refused rather than guessed.

A private index is just a URL you control. There is no account, no token, and no telemetry —
`/registry` makes exactly one GET for the index and one for the entry you install.

## Publishing

Two files and a static host. GitHub raw works, and so does anything that serves JSON over https.

```
your-registry/
  index.json
  skills/migration.md
  plugins/no-secrets.json
```

Three rules the validator enforces, so worth getting right first:

- The name in `index.json` must match the name inside the file. A skill's frontmatter `name` and a
  plugin manifest's `name` are both checked against the index entry.
- Names are `^[a-z0-9][a-z0-9-]*$`. No uppercase, no dots, no slashes.
- A plugin needs at least one deny rule. A manifest with an `appendix` and no rules is prompt
  text, which is what a skill is for.

Test it locally before publishing. `registryUrl` accepts `http://localhost`, so:

```bash
cd your-registry && python -m http.server 8000
```

```json
{ "registryUrl": "http://localhost:8000/index.json" }
```

`/registry` then exercises the real fetch, the real validation, and the real install path against
your files. That is the whole loop, without pushing anything.

## Troubleshooting

**"the registry index is malformed: …"** — the message names the first failing field. The usual
causes are an uppercase name, a `url` that is not https, or a plugin entry with no `deny`.

**"X calls itself Y but the index calls it X"** — the file's own name disagrees with the index.
Fix one of the two; the check exists so an index cannot serve something else under a name you
trusted.

**"invalid pattern …"** — a `pathPattern` or `commandPattern` is not a valid regex. Remember it is
JSON, so a backslash needs doubling: `\\.env$`, not `\.env$`.

**Installed but nothing happens** — installs load at startup. Restart, then check `/skills` or
`/plugins` for the entry and its origin.

**In `/plugins` with an error beside it** — the manifest on disk no longer validates. It is skipped
rather than fatal, so the agent still starts; `/registry remove` and reinstall.
