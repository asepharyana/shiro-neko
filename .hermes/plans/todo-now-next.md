# Plan: kerjakan TODO.md — Now + Next + Maintenance

## Scope
TODO.md status 2026-09-08:
- Now/Summarize pruned span — KODE SUDAH ADA (prune.droppedSpan, session.summarizeDiscarded, retained note, budget 6k excerpt + 3-6 lines, 3 tests). Checkbox masih [ ]. Action: flip ke [x] + tambah test "pruned decision recoverable".
- Now/Hot-reload — KODE SUDAH ADA (Session.updateSkills/updatePlugins + pendingSkills/pendingHost + drainPending + cli rebuild). Belum ada test mid-session callable. Action: tambah test + flip [ ].
- Next/MCP without schema tax — BELUM. 20 tools ~2750 tok/req.
- Next/Derive tool-name lists — BELUM. TOOL_SETS + MUTATING_TOOLS hand-list di tools.ts:877,913.
- Next/Subagent parallelism — BELUM. task sequential.
- Next/Undo a turn — BELUM.
- Maintenance 4 items — pricing note, estimateTokens label, listPaths 5k stale, MUTATING derive.

## Urutan eksekusi (kecil dulu, besar belakangan, tiap langkah typecheck+test)
1. **Now flip + tests** — patch TODO.md [x], test: hot-reload skill mid-session callable, pruned decision recoverable. Verifikasi: bun test.
2. **Derive tool-name lists** — tandai mutating di definisi tool (tools.ts/tools-extra.ts/tools-git.ts/tools-net.ts), TOOL_SETS & MUTATING_TOOLS derive + test coverage. Risiko: silently ungated write jika lupa.
3. **MCP tanpa schema tax** — phi 3 meta-tools mcp_list/mcp_inspect/mcp_call, prompt hanya nama server, permission+guard lewat built-in, keep direct registration untuk server 2-tool. Test: server 20-tool 0 schema sampai mcp_call.
4. **Subagent parallelism** — task terima beberapa investigations, run Promise.all dengan panel fan-out, test overlap waktu.
5. **Undo a turn** — snapshot file-tool edits pre-prompt (cap 100), /undo restores files+conversation atau keduanya, /redo, bash tidak ter-snapshot (docs), test edit reverted + record hilang.
6. **Maintenance polish** — pricing source+date, estimateTokens label everywhere /cost, listPaths notice staleness / refresh, MUTATING derive dari #2.

## Files per langkah
1. TODO.md, test/compact.test.ts, test/registry-hot-reload.test.ts (baru)
2. src/tools.ts, src/tools-extra.ts, src/tools-git.ts, src/tools-net.ts, src/tools-meta.ts (baru), test/tool-meta.test.ts
3. src/mcp.ts, src/tools-mcp-meta.ts (baru), src/prompt.ts, src/session.ts, test/mcp-meta.test.ts
4. src/subagent.ts, src/session.ts, test/subagent-parallel.test.ts
5. src/snapshot.ts (baru), src/commands.ts, src/session.ts, src/cli.tsx, test/undo.test.ts
6. src/pricing.ts, src/complete.ts, docs/*

## Verifikasi tiap langkah
- bun run typecheck (exit 0)
- bun test (790 -> bertambah, 0 fail)
- manual: /registry add skill:xxx lalu task di next turn tanpa restart; /cost label; mcp_list cost

## Aturan
- Spec dulu sebelum code (file ini).
- Satu langkah satu commit, pesan commit sebut TODO section.
- Jangan commit dry_run dead input atau README count bareng — itu bug terpisah.
