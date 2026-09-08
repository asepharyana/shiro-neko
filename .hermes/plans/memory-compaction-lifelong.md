# Plan: Lifelong Learning — Memory + Compaction Fix

## 1. Goal
Bikin shiro-neko cukup untuk agent yang belajar terus (lifelong) tanpa ngulang kesalahan setelah context compact / sesi ganti.

Status sekarang:
- Harness (session + prune + notebook): 7.5/10 — ladder prune, orphan repair, repeat guard sudah benar.
- Auto-memory: 4/10 — keyword literal, manual `remember`, boot block hits-only, MAX_TEXT 400, per-project silo, tanpa auto-consolidation.

Target: harness 9/10, memory 8/10 dengan perubahan kecil, backward-compatible, semua tes hijau.

## 2. Scope

### A. Memory (`src/memory.ts`)
- Search dari `terms.every(includes)` strict → scored hybrid (normalize + token + substring + hits + recency). Tetap require every term untuk kompatibilitas tes, tapi ranking jauh lebih baik dan tahan typo minor (underscore/hyphen/punct).
- Render boot block dari hits-only → diverse: top-hits + most-recent, dedup. Mencegah 20 gotcha lama mengusir decision baru.
- MAX_TEXT 400 → 800 (potong silent terlalu agresif untuk gotcha/decision berkonteks).
- Dedup dari exact `text===clean` → normalized (`lower + collapse ws + strip punct`) biar near-duplicate tidak dobel.
- TTL / decay: `pruneExpired(90d)` untuk entry hits==0 & umur >90d, dipanggil di load/persist. hits diberi recency bonus saat render, bukan decay destructive.
- Global memory: `~/.shiro-neko/memory/_global.json` sebagai layer kedua; per-project tetap utama, global untuk pattern lintas-repo.
- Auto-extract hook: `suggestFromTranscript(messages, model)` — 1x generateText yang meringkas sesi jadi 1-3 kandidat memory (dipakai session afterTurn, bukan auto-write diam-diam).

### B. Compaction (`src/prune.ts` + `src/session.ts`)
- estimateTokens: `len/4` → `len/3.6 + messages*8` (akun overhead role/tool envelope; terukur lebih dekat ke cl100k). Threshold tetap 120k.
- pruneToFit: selalu preserve head (first user goal + first assistant) terlepas ladder, jadi goal tidak hilang di narrowest rung.
- prepareStep di session: ladder tetap, tapi droppedSpan di-capture by identity dan di-ringkas via 1x generateText menjadi `Note (retained from compacted history)` user message (lossless compaction). Guarded try/catch — mock/dead model tidak break turn.
- afterTurn auto-memory: jika turn menambah >=4 pesan dan memory ada, tawarkan 1-3 kandidat via suggestFromTranscript (tidak auto-persist tanpa konfirmasi model; tool `remember` tetap sumber write).
- Repeat guard lintas-turn: `seen` sekarang Map dengan decay per 20 turn (opsional, ringan).
- Persist: onChange debounce 400ms → flush juga di `beforeExit` + tiap done (sudah ada), tambah flush on compact.

### C. Prompt / Wiring (`src/prompt.ts`, `src/cli.tsx`, `src/store.ts`)
- Prompt: memory block sekarang labeled `Project memory (project + global)`; notebook tetap survive compaction.
- cli.tsx: Memory ctor dapat global layer; `session.send` after done trigger suggest (off jika --no-memory).
- store: tidak diubah format, hanya notebook persistance tetap.

## 3. Files Touched
- `src/memory.ts` — utama (search, render, MAX_TEXT, dedup, global, TTL, suggest)
- `src/prune.ts` — preserveHead, estimate helper export, ladder keep
- `src/session.ts` — estimateTokens baru, summarizeDiscarded, afterTurn hook, cross-turn seen
- `src/prompt.ts` — minor label (opsional)
- `src/cli.tsx` — wiring global memory + afterTurn suggestion
- `test/memory.test.ts` — update expectation truncation 400→800, tambah tes diverse/ranking/TTL
- `test/prune.test.ts` — tambah preserveHead test
- `test/compact.test.ts` — tambah lossless-compaction test (mock summarize)

## 4. Schema / Types
- MemoryEntry tetap `{id,kind,text,createdAt,hits}` — tambah field opsional `lastHitAt?: string` untuk recency bonus (backward compat: fallback ke createdAt).
- Config tidak berubah (SHIRO_HOME, maxSpendUsd, etc).
- File: per-project `${hash(cwd)}.json`, global `_global.json` di root(). Format array JSON sama, corrupted → [].

## 5. Verification
- `bun run typecheck` — harus pass (verbatimModuleSyntax, noUncheckedIndexedAccess)
- `bun test` — semua existing + baru hijau; khusus:
  - memory.test: truncation 800, every-term strict tetap, hits+recency ranking, diverse render contains recent
  - prune.test: head goal survive narrowest rung, estimate monotonic
  - compact.test: droppedSpan summarized to retained note, tidak loop
- `bun run build` — `dist/shiro` bisa di-compile
- Manual: `SHIRO_HOME=$(mktemp -d) bun run src/cli.tsx -p "hello" --yolo --json` → compacted event + done, memory file terisi

## 6. Non-Goals (defer)
- Embedding vector search (butuh dep + infra) — trigram/BM25 cukup untuk sekarang, bisa follow-up.
- Subagent parallel fan-out — butuh executor custom, defer (catat di ROADMAP).
- MCP meta-tools — defer.

## 7. Rollout
- Implement memory.ts dulu → test
- prune.ts preserveHead + estimate
- session.ts summarizeDiscarded + wiring
- Update tests incremental, typecheck tiap langkah, jangan bulk.
