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

### 0.1.0-beta.2 (unreleased)

Fourteen built-in tools, up from six, with sets so the schema cost stays controllable.

**Visible process** — reasoning streams to a collapsed panel with an estimated token count,
`ctrl-r` expands it, and it leaves with the turn since it is progress rather than the answer.
The tool in flight is named from `tool-input-start`, before its arguments have finished
streaming, and cleared on its result.

**Message queue** — the input stays mounted while the model works. A prompt typed mid-turn
queues, the panel counts what is waiting, and the queue drains in order when the turn ends.
`esc` clears the queue as well as aborting. Queued slash commands replay as if typed.

**More tools** — `multi_edit` applies several edits to one file atomically, validating every
edit in memory first so a late failure cannot leave the file half-written. `list_dir` gives an
ignore-aware depth-limited tree. Five read-only git tools, spawned with a fixed argv rather
than a shell string, which is what makes them safe to auto-approve.

**`activeTools` gating** — `toolSets` in config: `core` always on, `edit-plus` and `git`
optional. A disabled set reaches neither the wire nor the system prompt. `/tools` names the
set each live tool came from.

**Pruning correctness** — a tool result whose tool call the pruner discarded is now dropped
with it. Message-counted pruning cut between an assistant tool-call and the tool message
answering it, and the OpenAI responses API rejects the result on its own with 400 "No tool
call found for function call output with call_id ...".

**Batch reads** — `read_many_files` takes up to twenty paths, each with its own window, and
runs them concurrently. An unreadable path is reported in its own block rather than throwing,
so one wrong guess costs a line instead of the call.

**`@file` completion** — `@` opens a picker fed by the ignore-aware walker, narrowing as you
type. Prefix matches rank above substring matches, so `@src/` means "under src/" rather than
"anything containing src/". Tab inserts a plain relative path. The walk happens on the first
`@` rather than at startup.

**Interruptible commands** — `ctrl-c` kills the command in flight and keeps the turn: the call
fails with a message saying the command did not finish and its effects are unknown, and the
model takes its next step from there. The kill takes the whole process tree, because killing
`cmd /c` alone leaves the real command holding both pipes open and the read never returns.

---

## Next

### Lossless-enough compaction

Compaction says the history was pruned but not what was in it, so the model can contradict
its own earlier decision with confidence. A summary of the discarded span costs one cheap
call and removes the whole class of problem.

### Cost control

Two halves of the same problem: an `explore` subagent pays the parent's reasoning rate for
what is really a search, and nothing stops a headless run that loops. A cheaper subagent model
and a per-session ceiling are both small changes on top of the pricing that already exists.

### Derived tool metadata

`TOOL_SETS` and `MUTATING_TOOLS` are hand-maintained lists of tool names. A tool added to one
and forgotten in the other is a silently ungated write. Marking each tool where it is defined,
and checking the coverage in the suite, removes the failure mode rather than documenting it.

### `web_fetch`

URL to markdown, in a `net` set that is off by default — it is the one tool that leaves the
machine.

Declined: wrappers around a single bash line with no added guarantee. `run_tests`,
`typecheck`, `lint`, `build` are five tools of pure schema tax when the real commands are
already in `AGENTS.md`.

---

## Later

**Subagent parallelism.** Two independent searches run sequentially today. The panel already
handles multiple agents; the loop does not fan out.

**Session branching.** Fork a session at a message to try a different approach without
losing the original.

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
