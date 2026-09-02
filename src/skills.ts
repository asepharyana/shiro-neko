import { tool } from 'ai';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { BUILTIN_SKILLS } from './skills-builtin';

export type SkillOrigin = 'builtin' | 'user' | 'project';

export type Skill = {
  name: string;
  description: string;
  origin: SkillOrigin;
  path?: string;
  body: string;
};

const MAX_BODY = 20_000;

/**
 * Minimal YAML frontmatter reader: `name` and `description` only.
 * A real YAML parser would be a dependency for two string fields.
 */
export function parseSkill(source: string, origin: SkillOrigin, path?: string): Skill | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source.trimStart());
  if (!match) return undefined;

  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.replace(/^["']|["']$/g, '').trim();
  }

  const name = meta['name'];
  const description = meta['description'];
  if (!name || !description) return undefined;

  return { name, description, origin, ...(path ? { path } : {}), body: match[2]!.trim().slice(0, MAX_BODY) };
}

const skillDirs = (cwd: string) => [
  { dir: join(process.env['SHIRO_HOME'] ?? homedir(), '.shiro-neko', 'skills'), origin: 'user' as const },
  { dir: join(cwd, '.shiro', 'skills'), origin: 'project' as const },
];

/**
 * Builtin, then user, then project. Later wins, so a project can override a
 * bundled skill by using the same name.
 */
export async function loadSkills(cwd = process.cwd()): Promise<Skill[]> {
  const byName = new Map<string, Skill>();

  for (const { name, source } of BUILTIN_SKILLS) {
    const skill = parseSkill(source, 'builtin');
    if (skill) byName.set(skill.name, skill);
    else byName.delete(name);
  }

  for (const { dir, origin } of skillDirs(cwd)) {
    let files: string[] = [];
    try {
      for await (const f of new Bun.Glob('*.md').scan({ cwd: dir, onlyFiles: true })) files.push(f);
    } catch {
      continue;
    }
    for (const file of files.sort()) {
      const path = join(dir, file);
      try {
        const skill = parseSkill(await Bun.file(path).text(), origin, path);
        if (skill) byName.set(skill.name, skill);
      } catch {
        continue;
      }
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Catalogue for the system prompt: names and one-line descriptions only.
 * Bodies stay out of context until the model asks, which is the point.
 */
export function renderSkills(skills: Skill[]): string {
  if (skills.length === 0) return '';
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return [
    '',
    'Skills available through the skill tool. Load one when its description matches the task,',
    'before you start working, and follow it as if the user had written it:',
    ...lines,
  ].join('\n');
}

export function createSkillTool(skills: Skill[]) {
  const names = skills.map((s) => s.name);
  return tool({
    description:
      'Load a skill: detailed instructions for one kind of task. Call it as soon as a skill description matches ' +
      `what you are about to do, then follow what it says. Available: ${names.join(', ') || 'none'}.`,
    inputSchema: z.object({
      name: z.string().describe('Skill name from the list in your instructions'),
    }),
    execute: async ({ name }) => {
      const skill = skills.find((s) => s.name === name.trim().toLowerCase());
      if (!skill) throw new Error(`No skill named "${name}". Available: ${names.join(', ') || 'none'}`);
      return `Skill "${skill.name}" (${skill.origin}). Follow these instructions for this task.\n\n${skill.body}`;
    },
  });
}

export { skillDirs };
