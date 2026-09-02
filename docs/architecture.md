# Architecture

## The loop

One turn is a `streamText` call whose stream is translated into UI events.

```
user prompt
  → messages.push({ role: 'user', ... })
  → streamText({ model, system, messages, tools, activeTools, reasoning, toolApproval })
      → for each stream part → yield an AgentEvent
      → if any tool needs approval, the stream ends suspended
          → collect decisions from the UI
          → push a tool message with the approval responses
          → loop
      → otherwise done
```

`src/session.ts` is an async generator. The UI consumes events; it never touches the SDK.
That is what lets the same session drive the Ink app, the headless printer, and the tests.

## Why approval goes through the SDK

An obvious design is a promise inside each tool's `execute`, resolved when the user answers.
That was rejected: it makes "denied" a convention the tool must remember to honour, and one
tool forgetting it is a silent security hole.

Instead the SDK's `toolApproval` is used. A denied call **provably never executes** — the SDK
never reaches `execute`. The tool cannot opt out because the tool is not consulted.

```ts
toolApproval: async ({ toolCall }) => {
  const blocked = await plugins?.guard({ toolName: toolCall.toolName, input: toolCall.input, cwd });
  if (blocked) return { type: 'denied', reason: blocked };   // --yolo cannot reach this
  if (yolo) return undefined;
  if (!needsApproval(toolCall.toolName)) return undefined;
  return 'user-approval';
}
```

Guards are checked first, so `--yolo` skips prompts but not refusals.

One subtlety: when this function denies, the SDK emits `tool-approval-request` with
`isAutomatic: true` and answers it itself. Queueing that would prompt the user for a call
that is already settled, so automatic requests are skipped and denial is surfaced from
`tool-approval-response` instead.

## Where state lives

The system prompt is rebuilt on **every step**, not once per turn:

```ts
prepareStep: ({ messages }) => {
  const instructions = this.systemFor();          // task list, memory, skills, agent
  if (estimateTokens(messages) <= threshold) return { instructions };
  return { instructions, messages: prunePreservingItems({ messages, reasoning: 'all', ... }) };
}
```

That is not an optimisation. A `todo_write` on step one must be visible to step two, and
`system:` on `streamText` is bound once for the whole run. Returning `instructions` from
`prepareStep` is the only place per-step state can enter.

The prompt also describes only the tools actually offered this turn. A prompt that mentions a
withheld tool teaches the model to attempt impossible calls.

## Rendering

Ink re-renders the whole tree on every `setState`. At 50 tokens a second that is 50 full
renders and a visibly flickering terminal.

Two things fix it:

- Finished lines go into `<Static>`, rendered once and never redrawn.
- Token deltas accumulate in a ref and flush on a 60 ms interval, not per token.

Markdown is parsed on every flush. An unclosed fence renders as a code block that grows,
which is what a reader expects while text is still arriving.

## Input

`ink-text-input` was replaced. It discards up and down before its own handler, so history
recall is impossible, and it only ever *shrinks* its internal cursor offset, so an externally
set value leaves the cursor stranded mid-string.

`src/ui/PromptInput.tsx` owns the cursor. That also gives home, end, and ctrl-a/e/k/u/w for
free. It hands up, down, tab, and escape to a parent callback first, so the command menu and
open panels can claim them before the input treats them as editing keys.

## Subagents

`task` runs a nested `streamText` with only `read_file`, `glob`, and `grep`. It returns one
message.

Two consequences follow from the tool set, not from policy:

- It can never need approval, because it has no gated tools.
- The parent's context holds the findings, not the search transcript.

Progress is reported through a callback, wired to a bus the panel subscribes to. Without the
bus the panel would need a reference to the tool, and the tool would need one to React.

## Provider differences

Two are handled explicitly.

**Thinking levels.** `off`/`low`/`medium`/`high`/`max` become `reasoning_effort` on OpenAI and
a `thinking` token budget on Anthropic. The SDK does the mapping; `src/agents.ts` only picks
the level.

**Endpoint fallback.** Newer OpenAI models reject function tools on `/v1/chat/completions`
and require `/v1/responses`. `src/fallback.ts` presents both as one model and switches when
the first rejects the request *shape* — 400, 404, 405, 415, 422, 501 with `isRetryable` false.
Retryable failures are left to the SDK's backoff.

The switch is sticky. Once an endpoint rejects the shape it will reject every later step too,
so re-probing it each turn would waste a round trip per step.

Only `api.openai.com` gets the chain. Third-party endpoints do not implement `/v1/responses`.

## Compaction and its repair

`pruneMessages({ reasoning: 'all' })` strips a reasoning item and keeps the message item from
the same response. The responses API treats the message as that reasoning item's dependent
and returns 400.

The two carry different ids, so they cannot be matched by id. What links them is the assistant
message they arrived in: one message is one response, and its reasoning item covers every
other item in it. `src/prune.ts` drops the dependent parts of any turn whose reasoning was
removed — which costs nothing, since pruning was already discarding those turns.

## Module map

| Module | Responsibility |
|---|---|
| `session.ts` | the loop, approvals, compaction, event stream |
| `tools.ts` | file and shell tools, ripgrep bridge, bash streaming |
| `ignore.ts` | gitignore-aware walker, path jail |
| `prompt.ts` | system prompt assembly from live state |
| `agents.ts` | variants, thinking levels |
| `skills.ts` | discovery, catalogue, `skill` tool |
| `memory.ts` | durable notes, search, model compaction |
| `notebook.ts` | session task list |
| `plugins.ts` | host, hooks, guard chain |
| `subagent.ts` | `task` tool and progress events |
| `ask.ts` | the `ask` tool |
| `mcp.ts` | MCP clients and namespacing |
| `fallback.ts` | endpoint chain |
| `prune.ts` | provider-item repair |
| `markdown.ts` | parser, no dependency |
| `store.ts` | sessions, prompt history |
| `config.ts` | resolution, model construction |
| `providers.ts` | presets, `/models` fetch |
| `pricing.ts` | USD rates |
| `commands.ts` | slash registry, parsing, menu matching |
| `headless.ts` | `-p` mode |
| `cli.tsx` | argv, wiring, lifecycle |
| `ui/*` | Ink components |

Every module is pure of the UI except `ui/`, and `ui/` never touches the SDK. The seam is the
`AgentEvent` stream.

## Testing

404 tests, no mocking framework. `MockLanguageModelV4` from `ai/test` drives the loop;
`ink-testing-library` drives the UI with real keystrokes; MCP is tested against a real stdio
server subprocess; provider wire formats are tested against a local HTTP server.

The pattern throughout is to assert on what actually crossed a boundary — what went on the
wire, what is on screen, what is on disk — rather than on internal calls.
