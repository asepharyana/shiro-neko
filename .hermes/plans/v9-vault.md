# v9 — Provider prompt caching, registry trust, external hooks, /init scaffold, workflow plan nudge, nudge escalation, skill autoload

Date: 2026-09-09
Status: spec

## Why

User asked what was missing; recommended: provider-side prompt caching (#1),
registry trust (#3), external hooks (#4), `/init` TODO/ROADMAP scaffold (#5),
workflow->plan skill nudge (#7), nudge escalation (#6). Structured diff
review (#2) is **deferred**: the SDK's tool-approval model cannot express
per-hunk approval, and it needs a rewrite hook that does not exist yet. This
spec covers the six implementable items.

## Scope per item

### 1. Provider prompt caching (ROADMAP Next #1)

Client-side memoization already makes the system prompt byte-identical across
steps when nothing volatile changed. The remaining half: tell the provider to
cache the stable prefix.

- Anthropic: `cache_control: { type: 'ephemeral' }` on the system prompt
  block when the model is Anthropic. SDK supports
  `system: [{ type: 'text', text, cache_control }]`.
- OpenAI: automatic prefix caching — nothing to send; skip.
- Implement: `src/prompt.ts` splits the rendered system prompt into a stable
  prefix (everything before the volatile notebook/memory/skills suffix) and
  the volatile suffix; `session.ts` decides where to cut based on version
  counters. When only volatile parts changed (notebook/memory/etc), keep the
  stable prefix byte-identical and mark it cacheable; the volatile tail rides
  the same request but does not invalidate the prefix cache.
- Provider routing: `Session` knows its model provider via `opts.modelId` /
  a `provider` option. Add `cacheSystemPrefix?: boolean` option; enable when
  provider is anthropic. SDK's own `cache_control` for Anthropic system
  arrays: `system: [...]` accepts per-block cache_control.
- Tests: unit test that the splitter produces the same stable prefix across
  differing notebook versions; an Anthropic-format prompt carries
  `cache_control` on the stable block; OpenAI-format omits it.

### 3. Registry trust (ROADMAP Next)

An index is trusted for its contents, not its authorship. Add publisher
signature verification for registry entries:

- `src/registry.ts` manifest gains optional `signature` + `signer` fields.
- A pinned public key per publisher in config (`registry.publishers[<name>] =
  ed25519 pubkey`). Use Node's `crypto.verify` with ed25519 (Node ≥ 16 has
  `crypto.verify` for ed25519 via `createPublicKey`).
- On install: when a manifest has `signature`, verify against the configured
  publisher key; mismatch → refusal naming the publisher and the expected key.
  When the manifest has no signature → refused with "unsigned; add the
  publisher key or install manually" unless `registry.allowUnsigned`.
- Legacy manifests (no signature field) remain installable only with
  `allowUnsigned`; a signed one with an unknown publisher → refusal.
- Tests: signature verifies; tampered body fails; unsigned refused unless
  allowUnsigned; unknown publisher refused.

### 4. External hooks (ROADMAP Later)

Pre-tool hooks that can rewrite tool input, with a trust story like Codex:
- `.shiro/hooks/` directory; each hook is an executable + a small manifest
  (`name`, `hook` = `pre_tool` | `after_turn` | ...; `tools` = `["*"]` or
  names).
- On load, hash each hook file (sha256); first run, hash is shown and the
  user approves or denies (approval prompt). The hash is recorded in
  `~/.shiro-neko/hooks.json` (name → hash → approved). A hook whose hash
  changed since approval is refused until re-approved.
- `pre_tool`: stdin gets `{tool, input, cwd}`, stdout gets
  `{"allow": true, "input": {...rewritten...}}` or `{"allow": false, "reason": ...}`
  or `{"blocked": "..."}`. A throwing/odd exit is treated as a block.
- `after_turn`: stdin gets a turn summary; output ignored.
- These extend `PluginHost.guard` (beforeToolCall) — a hook runs after the
  compiled plugins and before the permission check, so a hook cannot bypass
  the safety rules but can rewrite or refuse.
- Cap: `hookTimeoutMs` default 5000; a hook that hangs is killed.
- Tests: manifest parse; pre_tool rewrites input (default allow); pre_tool
  refusal blocks; unknown hook hash blocks until approved; after_turn runs;
  timeout kills a hung hook; a hook that returns garbage blocks.

### 5. `/init` scaffold TODO/ROADMAP/docs

`/init` already writes AGENTS.md. Extend it to optionally scaffold the
project-workflow files too:
- `initPrompt` stays; after the agent writes AGENTS.md, if the repo lacks
  TODO.md/ROADMAP.md/docs and the user wants the scaffold, write:
  - `TODO.md`: `# TODO\n\nNow\n\nNext\n\nMaintenance\n\n`
  - `ROADMAP.md`: `# Roadmap\n\n## Next\n\n`
  - `docs/` empty dir (or a placeholder README)
- CLI flag `/init` gains no new args; the agent's prompt gains the option.
  Headless: `--init-scaffold` flag writes the files directly (no model).
- Tests: scaffold produces the three files when missing; does not overwrite
  existing ones.

### 6. Workflow nudge escalation

Today: one nudge per session, then silence. Change to a gentle ladder:
- Nudge 1: same as today.
- Nudge 2 (if a later turn also writes without todo_update): "still no update
  to TODO.md; the project expects its task list kept current."
- Nudge 3: final, "last reminder; update TODO.md when you have a moment."
- Cap at 3 total (never infinite). `workflowNudged` → `workflowNudgeCount`.
- Tests: third nudge is the last; count capped.

### 7. Workflow → plan skill autoload

When the workflow policy renders (repo tracks progress), inject one extra line
so the model knows the `plan` skill exists and to load it before non-trivial
work:
```
- before non-trivial work, load the `plan` skill (spec-first) and follow it
```
- `workflowPolicy()` gains that line when enabled; test asserts it.

## Files touched

- src/prompt.ts — splitter + cache_control for Anthropic
- src/session.ts — provider routing, cacheSystemPrefix, nudge ladder, plan line
- src/registry.ts — signature verification
- src/hooks.ts — new: external hook loader/runner + hash trust
- src/plugins.ts — guard extension for hooks
- src/cli.tsx — --init-scaffold, hooks approval wiring
- src/config.ts — registry.publishers, registry.allowUnsigned, hooks.enabled
- src/init.ts or cli — scaffold writer
- docs/: hooks.md, registry.md, workflow.md, headless.md updates
- test/hooks.test.ts, registry-signature.test.ts, prompt-cache-split.test.ts,
  init-scaffold.test.ts, nudge-ladder.test.ts

## Verification

- bun run typecheck
- bun test (new files + full suite)
- bun run build
- Manual: headless --init-scaffold, a hook that rewrites input, a signed registry entry