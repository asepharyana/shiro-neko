# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1]

### Added

- **Rendered, resumed history.** A session restored with `-r`/`-c` or `/resume` now shows
  its saved conversation as real transcript lines instead of a blank prompt, converting the
  stored wire messages (user, assistant, tool calls and their results) into the same view the
  live loop paints.
- **`/undo` and `/redo`.** Every prompt snapshots the files on disk first (capped near the last
  100), and `/undo` restores files, trims the conversation, or both. `/redo` reverses it. A
  `bash` command's side effects are not files and cannot be rolled back, which is stated in the
  command output rather than hidden.
- **Parallel subagents.** The `task` tool accepts several independent investigations under a
  `tasks` array and runs them on separate context windows at the same time, joining their
  reports. A single call behaves exactly as before.
- **Lazy MCP tools.** By default an MCP server now contributes three meta-tools (`mcp_list`,
  `mcp_inspect`, `mcp_call`) instead of one schema per server tool, so a server exposing twenty
  tools stops costing ~2750 tokens per request until one is actually called. Set
  `"mcpMode": "eager"` to register every server tool up front. Named servers are still listed
  in the prompt, and calls route through the same permission rules and guard as before.
- **Hot-reloaded skill installs.** A skill installed from `/registry` mid-session is callable
  on the next turn without a restart (the `skill` tool reads its list live, so even the first
  install works). Plugins and external tools still need a restart because they join the guard
  chain and tool registry built once at boot.

### Fixed

- A resumed session rendered an empty transcript. Loading a saved session populated the wire
  messages but never rebuilt the on-screen history, so after `-r`/`-c` or `/resume` the talk
  was blank even though the session data was there.
- The walk behind `@file` completion refreshed only once per session; it now re-walks on a slow
  cooldown so a file created after the first `@` shows up within a short window.
- A handful of plugin write tools were mutating but not gated by the permission defaults; the
  tool set and the mutating list are now derived from a single `mutating()` marker, so a tool
  can no longer be added to one and forgotten in the other.

## [1.0.0]

The first stable release. Cost control, a larger tool and skill surface, custom slash
commands, auto-loaded extensions, and a redesigned welcome interface, on top of the beta
line's agent loop, approval model, and safety guarantees.

### Added

- **Spend ceiling** ("maxSpendUsd" in config). Checked before each turn: past the limit the
  model is never called, the turn is refused naming the ceiling, headless exits non-zero,
  and it warns once at 80% of the limit. Unpriced models cannot be measured, so the ceiling
  does not apply to them.
- **Cheaper subagent model** ("subagentModel" in config). "explore" subagents — search, not
  reasoning — resolve against a configured cheaper model while "review" and "worker" keep the
  parent's. "/cost" reports subagent spend separately, priced against the subagent's model id.
- **Twenty new built-in tools** (41 total) in a new "extra" tool set, across four families:
  - line edits: insert_lines, delete_lines, replace_lines, append_file, prepend_file, count_lines
  - filesystem: tree, file_info, find_files, recent_files, changed_files
  - git (read-only, argv-spawned): git_log_file, git_diff_commits, git_show_file, git_current_branch, git_changed_in_ref
  - code and environment: find_symbol, json_query, outline, read_symbol, env_info, count_tokens
- **Twenty new bundled skills** (29 total), including plan, docs, api-design, ci-cd, db,
  docker, frontend, git-workflow, logging, optimize-sql, release, accessibility, data, i18n,
  deps, onboarding, ux-copy, readme, incident, perf-frontend.
- **Ten new plugins**, all data. Safety refusals on by default — no-force-push, no-net-pipe,
  no-root, no-env-write — and opt-in workflow plugins — no-main-commit, no-git-config,
  confirm-delete, conventional-commit, tests-first, small-diffs.
- **Custom slash commands** from Markdown files in ".shiro/commands/" and
  "~/.shiro-neko/commands/", with frontmatter "description"/"agent", "$ARGUMENTS" and
  positional "$1", and shell substitution passed through the guard. A custom command can
  never shadow a built-in.
- **Auto-loaded external extensions** from "~/.shiro-neko/{skills,tools,plugins}" and
  ".shiro/{skills,tools,plugins}". All data, never code: tools are bounded manifests (a shell
  template through the guard, an HTTPS fetch, or a workspace read), plugins are refusal
  manifests. Malformed files are reported and skipped, never fatal.

### Changed

- **Skills now live as Markdown files** in "src/skills-md/", embedded into the compiled binary
  by Bun text imports, replacing the previous TypeScript string constants. A format test
  enforces that each parses with valid frontmatter and a real body. The eleven pre-existing
  skills were also deepened.
- **Welcome interface redesigned** into a structured dashboard: a session banner, a grouped
  environment panel with attention-worthy facts coloured out of the quiet layer, and a meta
  bar. The prompt input sits in a two-tone box with the agent and model row inside it and a
  split footer beneath.
- **System prompt advanced** with a discrete failure-recovery loop, a delegation policy, and
  compaction awareness.

### Fixed

- **Release workflow "dry_run" input is now honoured.** A manual dispatch publishes only when
  it is unchecked; tag pushes always publish. Previously the input was declared but never read,
  so a manual run could never publish regardless of its value.
- **Documentation drift** corrected across the tool count, the bundled-skill count, the plugin
  defaults, and the README quickstart.

## [0.1.0-beta.5]

- A dead provider item no longer ends the turn: a 404 naming a missing item rewrites the
  history inline and retries once.
- More tools (git_commit_message, git_branch, move_file, delete_file), the "protect" plugin,
  the security/perf/migrate skills, the "/mcp add" wizard, and the farewell message.

## [0.1.0-beta.4]

- Compaction no longer stops the loop, and is bounded to keep the widest recent tool tail.
- The external registry for skills and plugins.
- Permission rules matched per command and path, replacing the per-tool list.
- apply_patch, web_fetch, and writable worker subagents.

## [0.1.0-beta.3]

- Fourteen built-in tools with gateable tool sets.
- Streaming reasoning display, the mid-turn prompt queue, multi_edit, list_dir, read-only git
  tools, batch reads, @file completion, and interruptible commands.

## [0.1.0-beta.1]

- The core agent loop with SDK-enforced tool approvals, endpoint fallback, and retries.
- The initial tool set, Ink interface, agent variants, skills, plugins, per-project memory,
  session persistence, subagents, MCP, and five-platform builds.

[1.0.0]: https://github.com/zakirkun/shiro-neko/releases/tag/v1.0.0
