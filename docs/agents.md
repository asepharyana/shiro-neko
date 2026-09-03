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
and `bash` are withheld from the model, not merely discouraged in prose — a model that cannot
see a tool cannot call it. They keep everything that only reads, including `read_many_files`,
`list_dir`, and the git tools. Their prompts also forbid describing edits as if they had been
made.

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
