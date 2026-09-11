# Prioritize batched reads (read_many_files) for turn efficiency

## Problem
The model frequently calls `read_file` once per file when investigating, costing one
round trip each. `read_many_files` already exists and batches 2-20 files in one call,
but the guidance is weak: it is in `edit-plus` (not `core`), and the system prompt does
not tell the model to prefer batching. Turns burn more steps than needed.

## Scope
- Move `read_many_files` into the `core` tool set so it is always offered (even with
  minimal tool sets or a read-only variant).
- Strengthen the per-tool guidance in `src/prompt.ts` TOOL_DOCS: `read_file` says
  "prefer read_many_files when you need several files"; `read_many_files` becomes the
  primary reading instruction with an explicit batch hint (2-20).
- Add one "How to work" rule about reading efficiently (batch, grep/outline first,
  never read a file twice).
- `deep` agent variant: add a read-batching instruction to its appendix.
- Tests: assert `toolSetOf('read_many_files') === 'core'`; assert TOOL_DOCS contains
  the batching guidance; adjust any test asserting `read_many_files` is not core.
- Docs: mention read_many_files as the default reading tool in docs/tools.md.

## Files touched
- `src/tools.ts` — readManyFilesTool meta set: `'edit-plus'` → `'core'`.
- `src/prompt.ts` — TOOL_DOCS lines + a workflow rule.
- `src/agents.ts` — deep appendix line.
- `test/session-features.test.ts` or `test/tools.test.ts` — set assertion.
- `test/prompt.test.ts` — presence of batching guidance.
- `docs/tools.md` — reading guidance.

## Verification
- `bun run typecheck` clean.
- `bun test` — full suite green (tool sets + prompt + deep agent tests).
- `bun run build` compiles.

## Decision
Batched reads save one round trip per extra file — the single highest-leverage
efficiency win for investigation-heavy turns. Keep `read_file` (single-file reads,
offset/limit, still needed for one file) but steer batching as the default once the
file set is known.