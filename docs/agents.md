# Agents and thinking

An agent variant sets three things: how much the model deliberates, which tools it is
offered, and a behaviour appendix in the system prompt.

```bash
shiro --agent deep              # at launch
shiro --agent plan --think low  # variant with an overridden level
```

```
/agent          picker
/agent review   direct
/think          picker
/think max      direct
```

## The variants

| Variant | Thinking | Tools | Steps | For |
|---|---|---|---|---|
| `default` | medium | all | 50 | ordinary work |
| `quick` | off | all | 12 | small, well-scoped edits |
| `deep` | max | all | 80 | hard problems, unclear causes |
| `plan` | high | read-only | 50 | investigate and propose |
| `review` | high | read-only | 50 | critique a change |

**`quick`** tells the model not to deliberate, not to write a task list, and not to explore
beyond what the change needs. Good for a rename or a one-line fix where thinking budget is
pure latency.

**`deep`** asks for more than one hypothesis before acting, more reading before concluding,
and findings recorded with `remember` so they survive compaction.

**`plan`** and **`review`** are genuinely read-only. `write_file`, `edit_file`, `multi_edit`,
`apply_patch`, and `bash` are withheld from the model, not merely discouraged in prose — a
model that cannot see a tool cannot call it. They keep everything that only reads, including
`read_many_files`, `list_dir`, the git tools, and `web_fetch` when the `net` set is enabled.
Their prompts also forbid describing edits as if they had been made.

## Variants and tool sets

Two separate things narrow the tool list, and they compose.

A variant withholds tools by *capability*: `plan` cannot write, whatever the config says.
`toolSets` withholds them by *cost*: a project that never wants the git tools switches that set
off for every variant. See [tools](tools.md#tool-sets).

Both go through one function, so a withheld tool is missing from the wire and from the system
prompt together. `/tools` lists what is actually offered this turn, with the set each tool came
from.

## Thinking levels

`off`, `low`, `medium`, `high`, `max`. They map to whatever the provider actually supports:

| Level | OpenAI `reasoning_effort` | Anthropic `thinking` |
|---|---|---|
| `off` | `none` | `{ type: "disabled" }` |
| `low` | `low` | `budget_tokens: 6400` |
| `medium` | `medium` | proportional budget |
| `high` | `high` | `budget_tokens: 38400` |
| `max` | `xhigh` | maximum budget |

Verified against both wire formats rather than assumed. The vocabulary is deliberately ours:
`off` through `max` means the same thing whichever provider is configured, and switching
providers mid-session does not change what `/think high` asks for.

Higher costs more and takes longer. `off` on a hard problem produces confident wrong
answers; `max` on a rename wastes a few cents and several seconds. The variants pick
sensible defaults, so reach for `/think` only when a specific turn needs something else.

Reasoning is also charged as output tokens, so `max` shows up in `/cost` even on a turn where
the model wrote two lines. And reasoning is the **first thing compaction discards** — see
[memory](memory.md#compaction) — so a long turn at `max` pays for thinking that will not be on
the wire by the end of it.

## Steps

`maxSteps` caps how many model calls one turn may make. A step is one request: a tool call and
its result, or the final text.

| Variant | Steps |
|---|---|
| `quick` | 12 |
| `default`, `plan`, `review` | 50 |
| `deep` | 80 |

The cap is a backstop against a loop, not a budget to spend. A turn that hits it stops
mid-work with whatever it has, which is why `quick`'s 12 suits a rename and would strand a
refactor. If turns regularly hit the cap on the same kind of task, the task wants `deep`
rather than a higher number.

## Overriding

`--agent deep --think low` gives you `deep`'s tools, steps, and appendix with a low thinking
budget. The override clones the preset rather than mutating it, so a later `/agent deep` in
the same session still gets `max`.

## Defaults in config

```json
{ "agent": "deep", "thinking": "high" }
```

A flag beats the config file. An unknown name fails at startup with the valid list rather
than silently falling back:

```
$ shiro --agent turbo
shiro: Unknown agent "turbo". Available: default, quick, deep, plan, review
```

## What the variant changes in the prompt

The system prompt describes only the tools actually offered, and the workflow rules adapt.
Under `plan` the model is told it has no tools that change anything and that it cannot run
commands, so it should say what to run rather than claim it passed. Under `default` it is
told which tools need approval and to verify with the project's tests.

A prompt that describes a withheld tool teaches the model to attempt calls that cannot
succeed, which is why the description is generated from the live tool set.

Three rules flip on what is available:

| Condition | `default` says | `plan` says |
|---|---|---|
| can edit | "these need approval; if denied, stop and ask" | "you have no tools that change anything" |
| can run commands | "verify with the project's build or tests" | "say what should be run rather than claiming it passed" |
| can ask | "ask rather than guess when two readings differ" | (same, unless headless) |

The read-only variants are around 2,000 characters of system prompt against roughly 3,600 for
the full set — cheaper per turn as well as safer.

## Which to reach for

- **`default`** for anything you have not thought about. It is the right answer most of the time.
- **`quick`** for a rename, a typo, a one-line fix. Its value is not the model being cheaper but
  the absence of deliberation latency on work that needs none.
- **`deep`** when the first attempt already failed, or the cause is unclear. Asking for more than
  one hypothesis is the actual difference; the thinking budget is secondary.
- **`plan`** before a change you are not sure about. Read-only means the plan cannot quietly
  become a half-applied edit.
- **`review`** on a diff or a module. In headless CI this is the one that needs no `--yolo`,
  because it holds no tool that can modify anything — see [headless](headless.md).

Switching mid-session is fine and cheap: `/agent` changes the next turn's tools and prompt, and
nothing about the history.

## Delegating with `task`

The `task` tool spans a separate axis from the variants: it runs a subagent with its own
context window, so the parent pays for one report rather than the whole search transcript. The
subagent sees none of the parent's conversation, so its prompt must stand alone.

| Kind | Tools | Approval | For |
|---|---|---|---|
| `explore` (default) | read and search only | never prompts — structurally read-only | a search spanning many files |
| `review` | read and search only | never prompts | a critique of code or a diff |
| `worker` | everything, including writes | every write and command asks, through the parent's gate | a self-contained change whose steps you do not need to watch |

Three properties of the `worker` kind are structural rather than policy:

**The gate is the parent's.** A worker routes each gated call back through the same permission
rules, the same guard plugins, and the same approval prompt as a direct call — flagged `a
worker subagent wants to run ...` so you can tell who is asking. Answering `always` grants the
pattern for the session exactly as it does for you. A subagent that could approve its own
writes would be a way to launder a tool call past you, so there is no separate, weaker gate.

**Denial stops the work.** The worker is told a denial is your decision: report it, do not work
around it. The tool descriptions say the same thing, so the rule survives compaction.

**No `worker` without a channel.** In headless runs there is no one to answer a prompt, so the
`worker` kind is not offered at all — an unattended write is not something to fall into by
accident. The read-only kinds work everywhere. No subagent holds `web_fetch`; network access
stays with the main agent, where the approval prompt says what it is for.

When not to delegate: a single grep, or anything you must supervise step by step — keep that in
your own turn, where every call is on screen. A worker wins when the intermediate steps are
noise: a mechanical rename across twenty files, a test scaffold written to match an existing
suite, a cleanup whose shape you already know.

### Subagent model

By default a subagent runs on the same model as the parent. For read-only explorations and
reviews that is usually overkill — an `explore` search spanning many files pays the parent's
reasoning rate for what is really a grep with better recall. Set `subagentModel` in config to a
cheaper, faster model and every `task` call uses it instead:

```json
{ "subagentModel": "claude-sonnet-4-5" }
```

Omit it (or set it to a model that fails to resolve) to fall back to the parent model. `worker`
subagents inherit the same override; a worker that needs the parent's reasoning can be written
to do the careful parts in the main turn and delegate only the mechanical shell.

### Empty reports

A subagent that returns nothing at all — no tool steps and no text — is almost always a
transient failure rather than a real "nothing found". The very first such blank response is
retried once with a nudge to report, so a swallowed provider error does not surface as an empty
result. A run that did real tool work but never wrote a final answer is not retried: repeating
it would just redo the work, so it is handed back as-is for the parent to decide.
