# Maintenance polish — spec

## 1. Pricing source+date
File: `src/pricing.ts`
- Add file-level doc: source URLs (anthropic.com/pricing, openai.com/api/pricing, etc) + `Last verified: 2026-09-09` + note "hand-entered, verify before billing".
- Keep RATES as is (no rate change unless verified), but comment per-provider source.
- Export `PRICING_VERIFIED_AT = '2026-09-09'` for /cost panel to display.

## 2. estimateTokens label
Files: `src/prune.ts`, `src/session.ts`, `src/ui/panel-bodies.ts`
- `estimateTokens` already `len/3.6+8*msgs` with ~. Rename display everywhere to `~N tokens (est.)` or keep `~N` but add `(est.)` in /cost.
- Ensure `session.estimatedTokens()` doc says "estimate, not tokenizer".
- `costPanel` line already `~${n} tokens` -> change to `~${n} tokens (est.)`.

## 3. listPaths staleness
Files: `src/cli.tsx`, `src/ui/App.tsx`, `src/ignore.ts`
- Problem: `listPaths` walks 5000 once, caches in App `paths` state, never refreshes.
- Fix:
  - `cli.tsx` hooks.listPaths accepts `opts?: { force?: boolean }` and caches with 30s TTL + invalidation on file mutation via `session` snapshot hook (expose `invalidatePaths` or simple: App re-calls walk when file created).
  - Simplest reliable: App keeps `pathsVersion` bump; Session emits `onFileMutated` callback that App subscribes to -> `setPaths(undefined)` so next `@` re-walks. Also add manual refresh: `ctrl-r` while FileMenu open re-walks (or just always re-walk after 30s).
  - Implementation: add `fileChangeSeq` counter in Session, increment on recordBeforeWrite commit; App `useEffect` watches `session.fileChangeSeq` and invalidates `paths`.
  - Keep limit 5000, but add comment "refresh on file mutation, manual Tab still works".

## 4. MUTATING_TOOLS derive
Files: `src/permission.ts`, `src/tool-utils.ts`, `src/tools.ts`
- Today `MUTATING_TOOLS = mutatingNames(tools)` (derived from _meta) and `DEFAULT_PERMISSIONS` hand-lists `write_file:'ask'` etc — two sources.
- Fix: make DEFAULT_PERMISSIONS derive mutating entries from MUTATING_TOOLS. Keep special-case reads (`read_file` etc) explicit, then loop MUTATING_TOOLS to set `'ask'` unless already present. This makes _meta single source.
- Keep `MUTATING_TOOLS` exported (tests use it) but add comment "single source via _meta".
- Also add `FREE` already derived.

## Verifikasi
- npx tsc --noEmit 0
- bun test 804 -> still 0 fail (add pricing date test maybe)
- manual: /cost shows `~N tokens (est.)` + `pricing verified 2026-09-09`; create file then `@` shows it without restart.
