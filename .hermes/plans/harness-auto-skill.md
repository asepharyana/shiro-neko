# Plan: Harness auto-skill — memory spesifik, skill general

## Koreksi desain
- Sebelumnya: memory project + global layer (_global.json) untuk pattern universal. Salah.
- Seharusnya: memory = spesifik per project (path, command, decision repo itu). Skill = general/universal, auto-create.

## Goal
Harness yang belajar terus: tiap sesi yang menghasilkan pattern reusable lintas-repo -> otomatis jadi file skill di ~/.shiro-neko/skills/auto-*.md, kebawa di sesi berikut via loadSkills tanpa manual.

## Perubahan
1. src/memory.ts — hapus global layer (globalFile/globalEntries/addGlobal/renderWithGlobal). Balikkan prompt summarize & suggestFromTranscript ke project-spesifik (keep paths/names, one-off file fix BOLEH disimpan kalau spesifik repo). MAX_TEXT 800, dedup normalize, TTL 90d tetap.
2. src/skill-learner.ts — BARU. suggestSkillsFromTranscript(messages, model) -> SkillCandidate[] { name, description, body }, prompt: generalisasi ke peran (the auth layer, not src/auth.ts), condition->action->reason, skip repo-spesifik. writeAutoSkill(candidate): tulis ke ~/.shiro-neko/skills/auto-<slug>.md dengan frontmatter name/description, dedup by name+normalize(body), append section kalau file sudah ada, cap MAX_BODY 20k, best-effort.
3. src/session.ts — import skill-learner, afterTurn hook: maybeLearnSkills() (best-effort, catch, hanya kalau messages.length>=6 dan model ada). Dipanggil di send() finally setelah plugins.afterTurn, atau setelah run selesai. Tanpa block turn.
4. src/cli.tsx — tidak perlu wiring khusus; learner pakai SHIRO_HOME & Bun.write. Pastikan Memory ctor tidak lagi loadGlobal.
5. Test — memory.test tetap hijau (project-only), tambah skill-learner.test untuk dedup & write.

## Verifikasi
- bun run typecheck
- bun test (790 -> 79x)
- manual: SHIRO_HOME=$(mktemp -d) bun run src/cli.tsx -p "hello" --yolo --json -> cek ~/.shiro-neko/skills/auto-*.md terbuat saat pattern kuat
