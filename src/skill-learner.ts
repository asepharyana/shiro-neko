import { generateText, type LanguageModel } from 'ai';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type SkillCandidate = {
  name: string;
  description: string;
  body: string;
};

const MAX_BODY = 12_000;

function slugOf(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'auto-skill';
}
function normalizeBody(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '');
}
function hashBody(s: string): string {
  return createHash('sha256').update(normalizeBody(s)).digest('hex').slice(0, 16);
}
function skillDir(): string {
  return join(process.env['SHIRO_HOME'] ?? homedir(), '.shiro-neko', 'skills');
}

/** Parse candidates: primary ---SKILL block, fallback JSON array */
function parseCandidates(rawText: string): SkillCandidate[] {
  const out: SkillCandidate[] = [];
  const re = /---SKILL\s+name:\s*([a-z0-9-]{2,48})\s*---\s*description:\s*(.+?)\s*\nbody:\s*\n([\s\S]*?)\s*---END---/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawText)) !== null) {
    const name = slugOf(m[1]!);
    const description = m[2]!.trim().slice(0, 120);
    const body = m[3]!.trim().slice(0, MAX_BODY);
    if (body.length < 80) continue;
    if (!/^use when\b/i.test(description)) continue;
    out.push({ name: `auto-${name}`, description, body });
    if (out.length >= 2) break;
  }
  if (out.length > 0) return out;
  // JSON fallback: [{name, description, body}]
  try {
    const j = JSON.parse(rawText.trim());
    const arr = Array.isArray(j) ? j : [j];
    for (const e of arr) {
      if (!e || typeof e.name !== 'string' || typeof e.description !== 'string' || typeof e.body !== 'string') continue;
      const name = slugOf(e.name);
      const description = String(e.description).trim().slice(0, 120);
      const body = String(e.body).trim().slice(0, MAX_BODY);
      if (body.length < 80) continue;
      if (!/^use when\b/i.test(description)) continue;
      out.push({ name: `auto-${name}`, description, body });
      if (out.length >= 2) break;
    }
  } catch {}
  return out;
}

export async function suggestSkillsFromTranscript(
  messages: { role: string; content: unknown }[],
  model: LanguageModel,
): Promise<SkillCandidate[]> {
  if ((model as unknown as { provider?: string }).provider === 'unconfigured') return [];
  if (messages.length < 6) return [];
  try {
    const transcript = messages.slice(-24).map(m => {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content).slice(0, 2000);
      return `${m.role}: ${c}`;
    }).join('\n').slice(0, 9000);
    if (!transcript.trim()) return [];
    const { text } = await generateText({
      model,
      system: 'You distill UNIVERSAL, cross-repo skills from a coding transcript. Abstract away repo-specific paths/names/IDs into roles (e.g. "the ORM migration" not "src/db/migrate.ts"). Each skill must be a reusable pattern: when to use it, steps, why. Worth keeping for months across projects. Output 0-2 skills, each as:\n---SKILL name: kebab-case---\ndescription: one-line trigger, <80 chars, starts with "Use when ..."\nbody:\nmarkdown body (headings, steps, pitfalls) — no frontmatter, no code dump\n---END---\nIf nothing generalizes beyond this repo, output empty. Be strict. You may also output JSON array [{"name","description","body"}] as fallback.',
      prompt: transcript,
      maxRetries: 1,
    });
    return parseCandidates(text);
  } catch { return []; }
}

export async function writeAutoSkill(candidate: SkillCandidate): Promise<string | undefined> {
  const dir = skillDir();
  const { mkdirSync } = await import('node:fs');
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const path = join(dir, `${candidate.name}.md`);
  const safeDesc = candidate.description.replace(/[\n\r]+/g, ' ').replace(/"/g, "'").trim().slice(0, 120);
  const frontmatter = `---\nname: ${candidate.name}\ndescription: ${safeDesc}\n---\n\n`;
  const content = `${frontmatter}${candidate.body.trim()}\n`;
  const candHash = hashBody(candidate.body);
  try {
    const existing = await Bun.file(path).text();
    // exact hash dedup: body already present in any section
    const existingHash = hashBody(existing);
    if (existingHash === candHash) return undefined;
    // also check if candidate body hash appears as substring section hash
    // split existing by ## Update markers and hash each chunk
    const chunks = existing.split(/## Update/);
    for (const ch of chunks) if (hashBody(ch) === candHash) return undefined;
    const appended = `${existing.trimEnd()}\n\n---\n\n## Update \u2014 ${new Date().toISOString().slice(0, 10)}\n\n${candidate.body.trim()}\n`;
    if (appended.length > 20_000) return undefined;
    await Bun.write(path, appended);
    return path;
  } catch {
    await Bun.write(path, content);
    return path;
  }
}
