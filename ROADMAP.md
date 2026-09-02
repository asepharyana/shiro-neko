# Roadmap

What is built, what is next, and what has been deliberately declined. Reordered when
evidence says the order is wrong.

Nothing here is a date. Items move to [TODO.md](TODO.md) when they are next up.

---

## Shipped

### 0.1.0-beta.1

**Core loop** — `streamText` with tool approvals suspended and resumed through the SDK's
`toolApproval`, so a denied tool provably never executes. Endpoint fallback for OpenAI
reasoning models that reject function tools on `/v1/chat/completions`. Retry with backoff
for transient failures.

**Tools** — `read_file` `write_file` `edit_file` `glob` `grep` `bash`, all path-jailed to
the workspace. ripgrep bridge with a JavaScript fallback. `.gitignore` and `.shiroignore`
aware walking. Binary rejection. Live-streaming `bash` output.

**Interface** — Ink TUI with markdown rendering, slash command menu, readline input with
per-project prompt history, coloured diffs in approval prompts, and panels for tasks,
subagents, command output, questions, and command results.

**Agents** — five variants crossing thinking level with tool restrictions. `plan` and
`review` withhold mutating tools from the model rather than discouraging them.

**Skills** — frontmatter markdown, catalogue in the prompt and body on demand. Four bundled,
overridable per user and per project.

**Plugins** — tool contribution, auto-approval, `beforeToolCall` blocking, `afterTurn`
hooks, prompt appendices. `guard` refuses irreversible shell commands ahead of any approval,
including under `--yolo`.

**Memory and state** — durable per-project memory with hit-counted recall and model-driven
compaction. Session task lists with four states. Session persistence with resume. Context
compaction that repairs the provider-item dependencies pruning breaks.

**Subagents** — read-only `task` with `explore` and `review` flavours, progress streamed to
a panel.

**Asking** — the `ask` tool, withheld in headless runs rather than left to hang.

**MCP** — stdio and HTTP servers, tools namespaced `mcp__<server>__<tool>`, a failing server
reported rather than fatal.

**Distribution** — five-platform cross-compiled binaries, checksums, install scripts, CI on
three operating systems, tag-driven releases.

---

## Next

### Visible process

The agent's reasoning is discarded. `reasoning-delta` already arrives from the session; the
transcript drops it. A collapsed panel showing what the model is thinking, expandable with a
key, is the largest gap between this and a tool that feels responsive on a slow turn.

Also missing: which file is being read or written as it happens. `tool-call` events carry
the path but the transcript only shows a one-line summary after the fact.

### Message queue

Typing during a turn does nothing. It should queue and run when the turn ends. Interrupting
with `esc` then retyping loses the thought. Requires input to stay live while `busy`, which
means the prompt and the spinner have to coexist rather than swap.

### More tools

Measured cost: 553 characters of schema per tool, sent every request. Thirteen live tools is
already at the point where selection accuracy starts to matter, so the next additions need
`activeTools` gating per set before the count grows.

Ordered by value per line of code:

- `multi_edit` — several edits to one file atomically, killing read-edit-read-edit churn
- `list_dir` — a tree view, so the model stops globbing blindly to orient
- `read_many_files` — batch reads in one round trip
- git read-only set — `git_status`, `git_diff`, `git_log`, `git_show`, `git_blame`, all
  approval-free because they cannot mutate
- `web_fetch` — URL to markdown

Declined: wrappers around a single bash line with no added guarantee. `run_tests`,
`typecheck`, `lint`, `build` are five tools of pure schema tax when the real commands are
already in `AGENTS.md`.

### `@file` completion

Typing `@src/` should complete paths. The last real ergonomic gap in the input.

---

## Later

**Subagent parallelism.** Two independent searches run sequentially today. The panel already
handles multiple agents; the loop does not fan out.

**Session branching.** Fork a session at a message to try a different approach without
losing the original.

**Cost budgets.** A per-session ceiling that warns, then stops. Pricing and accounting exist;
the limit does not.

**Structured diff review.** Approve or reject individual hunks of an `edit_file` call rather
than the whole thing.

**Plugin loading from disk.** Plugins are compiled in. Loading `.shiro/plugins/*.ts` needs a
sandbox story first — a plugin that can block tool calls can also lie about blocking them.

**Prompt caching.** Anthropic and OpenAI both support it. The system prompt is rebuilt every
step for task-list freshness, which defeats a naive cache; splitting the stable prefix from
the volatile suffix would fix that.

---

## Declined

**A web UI.** This is a terminal tool. A browser front end doubles the surface area and
serves a different product.

**Model-agnostic prompt tuning.** Per-model prompt variants are a maintenance treadmill for
gains that evaporate on the next model release.

**Auto-commit.** The agent should never write git history without being asked. Commits are
the user's record of their own work.

**Vector search over the codebase.** ripgrep answers a scoped question in 135 ms with no
index to build, invalidate, or ship. An embedding store is a large amount of machinery for a
worse answer on a codebase that fits in a grep.

**Tool call retries on model error.** A model that produced a malformed call will usually
produce it again. Surfacing the error teaches it more than a silent retry.
