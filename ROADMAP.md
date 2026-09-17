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

### 0.1.0-beta.3

Fourteen built-in tools, up from six, with sets so the schema cost stays controllable.

`v0.1.0-beta.2` was tagged and never published: `bun build --compile
--target=bun-windows-x64` rejects `--windows-title` unless the host is Windows, and CI
releases every target from one Ubuntu runner. It passed locally and failed on the last of
five builds. The version was burned rather than moving a published tag.

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

### 0.1.0-beta.4

**Compaction no longer stops the loop.** The beta.2 repair dropped any assistant part whose
reasoning item pruning had removed. On a reasoning model that is every tool call, so past the
threshold the model could no longer see what it had already run — and re-ran it until the step
limit ended the turn. The fix strips the provider `itemId` rather than the part: without one the
same content is serialised inline instead of as an `item_reference`, so the dependency on the
pruned reasoning item disappears while the history survives. Compaction may shorten the
history; it must not blank it.

**Bounded compaction.** The fixed three-message tool window collapsed long transcripts to a
handful of messages — a 405-message run kept two of 202 tool calls. Pruning now drops
reasoning first and keeps the widest recent tool tail that fits a ladder, and the SDK's
step-to-step message carry-over does the rest: the model keeps its record of what it ran. The
turn reports one compaction event rather than one per step.

**External registry.** `/registry` browses, searches, installs, and removes skills and plugins
from an index over https. The two kinds are treated differently on purpose: a skill is prompt
text and is shown in full before it joins your system prompt, while a plugin is a validated
manifest of deny rules that the compiled guard evaluates. Loading code from a URL is declined
outright — a plugin that could block tool calls could otherwise lie about blocking them.

**Interface.** Context shown as a percentage of the compaction threshold, amber from two
thirds and red at 90, so a turn about to lose history says so first. Aligned command menu and
registry tables, and `/skills` and `/plugins` name the origin of every entry. Tool calls show
their load-bearing arguments — the paths a batch read is about to pull in, the files a patch
touches — and each result line carries an outcome summary.

**Permission rules.** Approval moved from a list of tool names to rules matched against the
call's subject: the command for `bash`, the path for a file tool. `bash` used to be a single
yes/no covering `git status` and `rm -rf`, so a user pressing `a` once during a batch removed the
gate for both — the check was strongest when it mattered least. Rules let `git *` run while
everything else asks, `always` grants the pattern rather than the tool, `.env` and `.pem` are
refused on read outright, and a call repeated identically three times in one turn asks even when
allowed. `--yolo` folds `ask` into `allow` and still cannot reach a deny rule or the guard.

Surveyed Claude Code, Codex, opencode, and phi before writing it. Three of the four had already
moved to per-pattern rules; the shape here is closest to opencode's, with the credential deny and
the repeat guard taken from it directly.

**`apply_patch`.** One atomic patch across files — add, update, move, delete — validated in
full before anything is written, so a failure on the fourth file leaves the first three
untouched. Permission rules match every path the patch touches, so denying `src/generated/*`
catches a patch that includes one among five files.

**`web_fetch`.** URL to markdown, size-capped, in a `net` tool set that is off unless asked
for — it is the one tool that leaves the machine. HTTPS is required for public hosts, private
and loopback addresses are refused, and redirects are re-checked one hop at a time so a public
URL cannot redirect into the cloud metadata endpoint.

**Writable worker subagents.** `task` gains a `worker` kind that holds the write tools and
routes every write and command through the parent's approval gate — the same rules, the same
prompt, the same session grants as a direct call. Without an approval channel the worker kind
is not offered at all rather than silently downgraded to read-only. `explore` and `review`
stay structurally read-only, and no subagent holds `web_fetch`.

---

### 0.1.0-beta.5

**A dead provider item no longer ends the turn.** An `item_reference` resolves only while the
provider still stores that item, so a resumed session — or one that fell back to `/v1/responses`
mid-turn — could fail with 404 "Item with id 'msg_...' not found" on every attempt, since every
retry sent the same reference. Compaction now strips every provider `itemId` from what it sends,
and a 404 naming a missing item rewrites the session's history inline and runs the request again,
once per turn and only before any output has been delivered.

**Interface.** Context shows the elapsed working time and a compaction warning as the threshold
approaches, diff lines are numbered, markdown task lists render, the prompt edits by word and
`ctrl-d` deletes to the end of line, and a farewell tells you how to resume the session.

**More tools.** `git_commit_message` writes a commit message from the staged diff and the
repository's own recent subjects, in one nested model call — it never commits, so it needs no
approval. `move_file` and `delete_file` fill the gap that made every rename a write-then-delete
pair: both are gated, `move_file` matches permission rules at both ends, and `delete_file`
refuses a directory because removing a tree is what the guard blocks in `bash`. `git_branch`
lists branches with the current one marked.

**More plugins.** `protect` refuses writes to `.git`, lockfiles, `node_modules`, vendored code,
and build output — files a tool owns rather than a person, where an edit leaves a repository
that looks fine and behaves wrongly. It ships on, alongside `guard` and `secrets`, and every
path-based guard now shares one helper that understands where each write tool keeps its paths.

**More skills.** `security` (trust boundaries, then injection, authorisation, traversal, SSRF),
`perf` (measure, locate, one change, stop at a target), and `migrate` (changelog first, every
call site before one edit, never hand-merge a lockfile) join the bundled set.

**The MCP panel.** `/mcp add` walks through a local or remote server — kind, name, command and
arguments or URL and headers — validating the name against the `mcp__<server>__<tool>`
namespace as it is typed rather than failing at connect. `/mcp` lists what is configured with
each server's live tool count or its connection error, and `/mcp remove` takes one out. All
three write `config.json` directly; a new server connects on the next start, because
connecting mid-turn would change the tool list under a running request.

### 1.0.0

The first stable release. The beta line's architecture held; this release rounds out cost
control, extensibility, and the interface, and hardens the test suite to match.

**Cost control.** Two halves of one problem, both shipped. A **spend ceiling** (`maxSpendUsd`)
checks before each turn: past the limit the model is never called, the turn is refused naming
the ceiling, headless exits non-zero, and it warns once at 80%. A **cheaper subagent model**
(`subagentModel`) runs `explore` — which is search, not reasoning — on a less expensive model
while `review` and `worker` keep the parent's; `/cost` reports subagent spend as its own line,
priced against the subagent's model id.

**Tools: 41 built-in.** Twenty new tools in four families, all path-jailed and ignore-aware,
in a new `extra` tool set: precise line edits (`insert_lines`, `delete_lines`, `replace_lines`,
`append_file`, `prepend_file`, `count_lines`), filesystem navigation (`tree`, `file_info`,
`find_files`, `recent_files`, `changed_files`), read-only git extensions (`git_log_file`,
`git_diff_commits`, `git_show_file`, `git_current_branch`, `git_changed_in_ref`), and code and
environment reads (`find_symbol`, `json_query`, `outline`, `read_symbol`, `env_info`,
`count_tokens`). Every git call still spawns the binary with a fixed argv, never a shell.

**Skills: 29 bundled, as Markdown.** The catalogue grew from nine to twenty-nine and every
skill moved to a single source of truth: a Markdown file in `src/skills-md/`, frontmatter and
body, embedded into the compiled binary by Bun text imports. A format test enforces that each
one parses and carries a real body.

**Plugins: 10 more, all data.** Six narrow safety refusals (force push, pipe-to-shell, root
elevation, env credential writes, main-branch commits, git config changes) and three advisory
plugins (conventional commits, tests-first, small diffs) plus a delete guard for ambiguous
paths. The safety refusals are on by default for the same reason the guard is; the opinionated
ones are opt-in.

**Custom slash commands.** A Markdown file in `.shiro/commands/` or `~/.shiro-neko/commands/`
becomes a slash command, with frontmatter `description`/`agent`, `$ARGUMENTS` and `$1`
positionals, and `` !`cmd` `` substitution passed through the guard. A custom command can never
shadow a built-in.

**Auto-loaded extensions.** External skills, tools, and plugins load from
`~/.shiro-neko/<kind>/` and `.shiro/<kind>/` — all data, never code. An external tool is a
bounded manifest (a shell template through the guard, an HTTPS fetch, or a workspace file
read); an external plugin is a refusal manifest. A malformed file is reported and skipped,
never fatal.

**Interface.** The welcome screen is a structured dashboard — a session banner, a grouped
environment panel with attention-worthy facts lifted out of the quiet layer, and a meta bar —
replacing a wall of dim text. The input sits in an OpenCode-style two-tone box with the
agent·model row inside it and a split footer beneath.

---

## What the other agents have

Surveyed opencode, Claude Code, Codex CLI, and phi against this tool's feature set. The point of
the table is to record what is *worth copying* and what is worth *declining*, not to chase parity:
each of these four spent effort here deliberately, and several of their choices are load-bearing for
a reason that applies to us.

The four are not the same shape. **Claude Code** and **Codex** are first-party CLIs tied to one
vendor's models; **opencode** and **phi** are open-source and provider-agnostic, and opencode in
particular is the closest thing to a peer here. Where a feature exists, the notes say what it costs
— several are cheap to copy, and three are not.

### Where the four agree

Six features have converged across all or nearly all of them. Convergence is the strongest signal
available that a feature is not a fad — and the gaps in the table are as informative as the checks,
because they show which features are genuinely optional and which are table stakes.

| Feature | opencode | Claude Code | Codex | phi | Here |
| --- | --- | --- | --- | --- | --- |
| Per-pattern permission rules | `permission.bash` globs | `settings.json` allow/deny/ask | `approval_policy` + rules | Gate + `permissions.mode` | **shipped** |
| Subagents with fresh context | `mode: subagent` | `agents/*.md` | — | sub-agents | **shipped** |
| Markdown-defined agents | `agents/`, `commands/` | `agents/`, `skills/` | `AGENTS.md` | `.phi/` | **shipped** |
| Session resume | `--session`, `--continue` | `--resume`, `--continue` | resume + rollout files | `sessions` | **shipped** |
| Compaction | auto + `/compact` | `/compact`, `/rewind` summarize | compact prompt file | — | **shipped** |
| Undo / rewind | `/undo`, `/redo` (via git) | `/rewind` (snapshots) | — | — | **missing** |

Two of the six are outright missing from one or more tools, and undoing is missing from two of the
four — so it is a real feature, not table stakes, and the two that have it disagree about how. The
permission model here is not behind: it already carries the per-pattern rules, the credential deny,
and the repeat guard the others arrived at, and `doom_loop` (below) is the one refinement worth
taking. **Undo is the single converged feature genuinely absent**, which is why it leads Next.

### Detail worth having, by tool

**opencode** — the closest peer, and the source of the permission shape already adapted here.
`/undo` and `/redo` revert file changes **through git**, so they require the project to be a git
repository; this is a real limitation, not an implementation detail, and it means an undo is only
as good as the working tree's state. Agents are `primary` (build, plan) or `subagent` (general,
explore, scout), switchable with Tab or `@`-mention, configured in `opencode.json` or Markdown
frontmatter. A subagent runs in a **child session** with its own navigation keybinds
(`session_child_first`, `session_parent`), and `subagent_depth` (default 1) caps nesting. Notable:
`doom_loop` is a first-class permission key that fires when the same tool call repeats three times
with identical input — the repeat guard here is an approval rule; theirs is a named primitive with
its own recovery prompts. Sessions share over a URL (`/share`), which is a hosted product decision,
not a local one.

**Claude Code** — the most complete implementation of undo, and worth reading before building one.
Checkpointing snapshots **before every user prompt**, keeps the **100 most recent** checkpoints,
and stores them with the conversation so `/rewind` survives a resume. The rewind menu offers five
distinct actions, and the split is the interesting part: *restore code*, *restore conversation*,
*restore both*, *summarize from here*, *summarize up to here*. That is undo and compaction sharing
one control surface. The honest limits are documented rather than hidden: only `Write`/`Edit`/
`NotebookEdit` are tracked, `bash` side effects are not, **subagent edits are not captured** unless
the skill ran in the foreground with `context: fork`, and symlinked or hard-linked files are
skipped with an explicit warning. Their hook surface is the largest of the four — see *External
hooks* under Later, which is where that capability belongs here.

**Codex** — the sandbox is the differentiator, and it is genuinely hard to copy. Apple Seatbelt on
macOS, Landlock + seccomp on Linux, and a restricted-token/AppContainer mechanism on Windows, with
`workspace-write` the default and network **off** unless `sandbox_workspace_write.network_access`
is set. `approval_policy` is now `on-request | never | { granular = {...} }` — `untrusted` was
**retired** and can prevent the client from starting. Also shipped and worth knowing:
`approvals_reviewer = "auto_review"` routes an approval prompt through a *reviewer subagent*
rather than the user. `AGENTS.md` resolves global → project root → cwd, one file per directory,
`AGENTS.override.md` winning, capped by `project_doc_max_bytes` (32 KiB default).

**phi** — small (Go, ~12 MB), and the two ideas most worth stealing. First, **MCP without context
death**: server tool schemas never enter the prompt; the system prompt lists only **server names**,
and the model uses three meta-tools — `mcp_list`, `mcp_inspect`, `mcp_call` — with subprocesses
starting lazily on first use. This is the concrete design behind *MCP without the schema tax*
under Next. Second, the
hook contract is the cleanest of the four: `pre_tool` runs **before** the permission gate and can
`allow`, `deny`, or **`modify`** the input; `post_tool` can append model-facing `context` or
rewrite `output`. Exit code `2` is a hard deny; `fail_closed` decides crash behaviour; in
`readonly` mode only `fail_closed` hooks run, so a slow audit hook cannot stall exploration.

### Corrections to what this file said before

Two claims previously written here were incomplete, and the research fixes them:

- **Input-rewriting hooks are not phi's alone.** Codex ships it too: `PreToolUse` returns
  `permissionDecision: "allow"` with `updatedInput` to rewrite a call, verified in their docs and
  in `codex-rs/.../mcp.rs` (`with_updated_hook_input`). Two independent implementations make this
  the standard shape rather than one project's quirk — which raises its priority, and means the
  compiled plugin interface here is now the odd one out.
- **Codex's hook trust is exactly as described, and the mechanism is now known.** Non-managed
  hooks cannot run until reviewed: Codex persists a `trusted_hash` in `config.toml`, records trust
  against the hook's **current hash**, and marks new or changed hooks for review in `/hooks`.
  `--dangerously-bypass-hook-trust` skips it for one invocation. The known hole is instructive: a
  reviewer on their PR noted that **replacing the script a hook points at does not reset trust**,
  because only the config is hashed. A trust story that hashes the declaration but not the artefact
  is a partial one — worth designing past rather than copying.

### What is worth declining

Three of their features are deliberate here, and the survey confirms the reasoning:

- **A client/server split** (opencode's OpenAPI server + TUI-as-client + IDE/web clients) exists to
  serve *second clients*. No second client is wanted here.
- **LSP integration** — the quote already cited in Declined is accurate and now verified in full:
  opencode's own LSP page says it "is useful in some projects, but it is not always a net positive,"
  that servers "can get out of sync, use significant memory, vary by version or project, and slow
  down agent workflows," and that "in many projects it is better to have the agent run lint,
  typecheck, or other diagnostic CLI tools directly." They ship 30+ built-in servers and still say
  this. That is the strongest possible endorsement of the position in Declined.
- **Session sharing over a URL** (opencode `/share`) is a hosted-service feature and brings a
  privacy surface this tool has no reason to take on.

---

## Next

### MCP without the schema tax

Every MCP tool's schema is in the prompt on every request, and `toolSets` does not gate them: a
twenty-tool server costs roughly 2,750 tokens a turn whether the model touches it or not. phi's
answer is three meta-tools — `mcp_list`, `mcp_inspect`, `mcp_call` — with the prompt naming only
the servers, so a hundred servers cost almost nothing until one is called. Worth keeping direct
registration as an option: for a two-tool server the indirection is the more expensive of the two.

### Undo a turn

Every comparable CLI has this: opencode `/undo` and `/redo`, Claude Code `/rewind` with
checkpoints. There is `/resume` here, which restores a session, and nothing that walks one back.
Claude Code's implementation is the one to read first, because it has already worked out the seams:
it snapshots before **every user prompt**, keeps the **100 most recent**, stores snapshots with the
conversation so a rewind survives a resume, and splits one menu into *restore code*, *restore
conversation*, *restore both*, and *summarize from here / up to here* — undo and compaction on one
control surface. opencode's version is simpler and takes a different position: it reverts through
**git**, so it needs a repository and inherits whatever the working tree already contained.

Both document the same hard limit, and so must this: a `bash` command's effects cannot be
snapshotted. Claude Code tracks only its own file-edit tools, explicitly does not cover `bash`
side effects, and does not capture subagent edits unless the fork ran in the foreground. The
honest version here covers file-tool edits, says so in the command's own output, and reports what
it skipped rather than pretending the tree is clean — the same shape used for an interrupted
command, whose effects are already reported as unknown.

### Lossless-enough compaction

Compaction keeps the model's memory of a turn now, but it still says nothing about the messages it
discarded, so the model can contradict its own earlier decision with confidence. A summary of the
discarded span costs one cheap call and removes the whole class of problem.

### Derived tool metadata

`TOOL_SETS` and `MUTATING_TOOLS` are hand-maintained lists of tool names. A tool added to one
and forgotten in the other is a silently ungated write. Marking each tool where it is defined,
and checking the coverage in the suite, removes the failure mode rather than documenting it.

### Registry trust

An index is trusted for its contents, not its authorship: `registryUrl` is the whole trust
decision, and there are no signatures. Publisher keys and a pinned digest per entry would make
"install this skill" a decision about a specific artifact rather than about a URL.

### Auto-review an approval

Codex ships `approvals_reviewer = "auto_review"`: an eligible approval prompt is routed through a
reviewer **subagent** instead of surfacing to the user, using the same sandbox boundary. `explore`
and `review` already exist and are read-only, so the piece to build is a reviewer persona that
decides an approval request and a policy that says which prompts are eligible — a batch of three
identical `git status` calls should not each interrupt, but a first `rm` should. The failure mode
to design against is a reviewer that waves through exactly what the user would have stopped, so it
must be opt-in, name itself when it approves, and never override a deny rule.

### Name the repeat guard

opencode has `doom_loop` as a first-class permission key: it fires when the same tool call repeats
three times with identical input, carries its own recovery prompts, and is configurable per agent.
The equivalent here is a rule inside the permission layer — the call repeated identically three
times in one turn asks even when allowed — which works but is unnamed, unconfigurable, and
invisible in `/tools`. Promoting it to a named primitive makes it inspectable and lets an agent
tighten or loosen it, and the recovery prompt is the part genuinely missing: a loop is better
interrupted with advice than with silence.

### `web_fetch`

Shipped in beta.4 — see above. What remains declined: wrappers around a single bash line with
no added guarantee. `run_tests`, `typecheck`, `lint`, `build` are five tools of pure schema tax
when the real commands are already in `AGENTS.md`.

---

## Later

**Subagent parallelism.** Two independent searches run sequentially today. The panel already
handles multiple agents; the loop does not fan out.

**Session branching.** Fork a session at a message to try a different approach without
losing the original.

**Structured diff review.** Approve or reject individual hunks of an `edit_file` call rather
than the whole thing.

**Plugin code from disk.** Declarative manifests ship in beta.4, and that is the whole of it
for now. Loading `.shiro/plugins/*.ts` needs a sandbox story first — a plugin that can block
tool calls can also lie about blocking them, and one that can execute can read whatever the
agent can read.

**Prompt caching.** Anthropic and OpenAI both support it. The system prompt is rebuilt every
step for task-list freshness, which defeats a naive cache; splitting the stable prefix from
the volatile suffix would fix that.

**External hooks.** Every one of the four surveyed except here lets a script sit in the tool loop:
a directory with a manifest and an executable, one JSON object in on stdin, one out. **Both** phi
and Codex let a `PreToolUse` hook **rewrite** a tool's input, not merely allow or deny it — phi
returns `{"action":"modify","input":{...}}`, Codex returns `permissionDecision: "allow"` with
`updatedInput` — and that is the exact capability the compiled plugin interface here cannot
express. Two independent implementations make it the expected shape rather than one project's
quirk. What blocks it is the trust story, not the mechanism.

The trust story has a known shape and a known hole. Codex will not run a non-managed hook until it
has been reviewed: it persists a `trusted_hash` in `config.toml`, records trust against the hook's
current hash, and lists new or changed hooks for review under `/hooks`;
`--dangerously-bypass-hook-trust` overrides for one invocation. The hole is that only the
**declaration** is hashed — replacing the script the hook points at does not reset trust, as a
reviewer on their own PR pointed out. Hashing the declaration *and* the artefact is the minimum
worth doing here, and it is why this is work rather than a weekend.

**OS-level sandboxing.** The strongest thing in this class, and Codex is the one that has it:
Seatbelt on macOS, Landlock and seccomp on Linux, a restricted-token/AppContainer mechanism on
Windows, with network **off** by default under `workspace-write`. Permission rules gate the *call*;
a sandbox governs what the process can then reach. Note that even Codex's sandbox is not a complete
boundary — their own hook docs say "hooks are guardrails, but they are not a complete enforcement
boundary for every shell or tool path." Three platform-specific implementations, and OpenAI moved
Codex to Rust partly for this. A half-built sandbox is worse than none, because people would trust
it.

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

**A client/server split.** opencode runs a server and treats its TUI as one client of an OpenAPI
endpoint, which is what lets IDE extensions and a web client exist. It is the right architecture
for that product. Here it would add a protocol, a port, and an auth story to serve a second client
nobody has asked for.

**LSP integration.** opencode ships 30+ built-in language servers and its own documentation still
says the honest thing: LSP "is useful in some projects, but it is not always a net positive,"
servers "can get out of sync, use significant memory, vary by version or project, and slow down
agent workflows," and *"in many projects it is better to have the agent run lint, typecheck, or
other diagnostic CLI tools directly."* That is the strongest available endorsement of declining it:
the project with the most invested says it is often the wrong trade. `bash bun run typecheck` puts
the same errors in front of the model with none of that, and `AGENTS.md` is where the command
belongs.
