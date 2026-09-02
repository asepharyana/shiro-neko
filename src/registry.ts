import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Plugin } from './plugins';
import { parseSkill, type Skill } from './skills';

/**
 * External skills and plugins, fetched from an index over HTTPS.
 *
 * Two kinds, and they are not equally safe.
 *
 * A **skill** is prompt text. Installing one puts a stranger's words into the
 * system prompt of every future session in this project, which is prompt injection
 * by invitation. The command shows the body before writing it and the origin is
 * recorded, so `/skills` always says where an instruction came from.
 *
 * A **plugin** is declarative: a name, a prompt appendix, and deny rules matched
 * against tool input. Never code. Loading arbitrary TypeScript from a URL would let
 * an entry read every file the agent can read and lie about blocking anything, so
 * that is not offered at any price.
 */

const MAX_INDEX_BYTES = 256 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
/** A pattern from the internet runs on every tool call; a huge one is a denial of service. */
const MAX_PATTERN = 200;

/**
 * https only, with localhost allowed so the suite can serve a real index.
 *
 * `file:` would read a local path and `data:` would inline a payload, neither of
 * which is what "fetch this from a registry" means to the person typing it.
 */
export function isFetchable(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
}

const entrySchema = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    // The name becomes a filename. Anything else is a path traversal.
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits, and dashes only'),
  description: z.string().min(1).max(300),
  // z.url() accepts file: and data:, which would read a local path or inline a
  // payload. Only https reaches the network the way the user expects.
  url: z
    .string()
    .url()
    .refine((u) => isFetchable(u), 'must be an https URL'),
  author: z.string().max(80).optional(),
});

const indexSchema = z.object({
  skills: z.array(entrySchema).max(500).optional(),
  plugins: z.array(entrySchema).max(500).optional(),
});

export type RegistryKind = 'skill' | 'plugin';
export type RegistryEntry = z.infer<typeof entrySchema> & { kind: RegistryKind };

const denyRuleSchema = z
  .object({
    tools: z.array(z.string().max(60)).min(1).max(30),
    pathPattern: z.string().max(MAX_PATTERN).optional(),
    commandPattern: z.string().max(MAX_PATTERN).optional(),
    reason: z.string().min(1).max(300),
  })
  .refine((r) => r.pathPattern !== undefined || r.commandPattern !== undefined, {
    message: 'a deny rule needs pathPattern or commandPattern',
  });

const manifestSchema = z.object({
  name: z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().min(1).max(300),
  appendix: z.string().max(2000).optional(),
  deny: z.array(denyRuleSchema).min(1).max(50),
});

export type PluginManifest = z.infer<typeof manifestSchema>;

export const DEFAULT_INDEX_URL =
  'https://raw.githubusercontent.com/zakirkun/shiro-neko-registry/main/index.json';

const home = () => process.env['SHIRO_HOME'] ?? homedir();

export const skillsDir = () => join(home(), '.shiro-neko', 'registry', 'skills');
export const pluginsDir = () => join(home(), '.shiro-neko', 'registry', 'plugins');

async function fetchText(url: string, limit: number): Promise<string> {
  if (!isFetchable(url)) throw new Error(`refusing a non-https URL: ${url}`);
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url} returned ${res.status} ${res.statusText}`);

  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > limit) throw new Error(`${url} is ${declared} bytes, over the ${limit} byte limit`);

  const text = await res.text();
  if (text.length > limit) throw new Error(`${url} is over the ${limit} byte limit`);
  return text;
}

/** Parses an index document. Exported so the shape can be tested without a network. */
export function parseIndex(source: string): RegistryEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new Error('the registry index is not valid JSON');
  }

  const parsed = indexSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`the registry index is malformed: ${parsed.error.issues[0]?.message ?? 'unknown reason'}`);
  }

  const seen = new Set<string>();
  const entries: RegistryEntry[] = [];
  for (const kind of ['skill', 'plugin'] as const) {
    for (const entry of parsed.data[`${kind}s`] ?? []) {
      const key = `${kind}:${entry.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ ...entry, kind });
    }
  }
  return entries;
}

export async function fetchIndex(url = DEFAULT_INDEX_URL): Promise<RegistryEntry[]> {
  return parseIndex(await fetchText(url, MAX_INDEX_BYTES));
}

export const searchEntries = (entries: RegistryEntry[], query: string): RegistryEntry[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter(
    (e) => e.name.includes(needle) || e.description.toLowerCase().includes(needle),
  );
};

/** Validates a plugin manifest, including that every pattern is a usable regex. */
export function parseManifest(source: string): PluginManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new Error('the plugin manifest is not valid JSON');
  }

  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`the plugin manifest is malformed: ${parsed.error.issues[0]?.message ?? 'unknown reason'}`);
  }

  for (const rule of parsed.data.deny) {
    for (const pattern of [rule.pathPattern, rule.commandPattern]) {
      if (pattern === undefined) continue;
      try {
        new RegExp(pattern, 'i');
      } catch (e) {
        throw new Error(`invalid pattern "${pattern}": ${(e as Error).message}`);
      }
    }
  }

  return parsed.data;
}

/**
 * A manifest as a Plugin.
 *
 * Rules are data, so the guard is the same code for every installed plugin: match
 * the tool name, then the path or command against a compiled regex. Nothing from
 * the manifest is ever evaluated.
 */
export function manifestToPlugin(manifest: PluginManifest): Plugin {
  const rules = manifest.deny.map((rule) => ({
    tools: new Set(rule.tools),
    path: rule.pathPattern ? new RegExp(rule.pathPattern, 'i') : undefined,
    command: rule.commandPattern ? new RegExp(rule.commandPattern, 'i') : undefined,
    reason: rule.reason,
  }));

  return {
    name: manifest.name,
    description: `${manifest.description} (installed)`,
    ...(manifest.appendix ? { appendix: manifest.appendix } : {}),
    beforeToolCall: ({ toolName, input }) => {
      const o = (input ?? {}) as Record<string, unknown>;
      const path = typeof o['path'] === 'string' ? o['path'] : '';
      const command = typeof o['command'] === 'string' ? o['command'] : '';

      for (const rule of rules) {
        if (!rule.tools.has(toolName)) continue;
        if (rule.path && path && rule.path.test(path)) return rule.reason;
        if (rule.command && command && rule.command.test(command)) return rule.reason;
      }
      return undefined;
    },
  };
}

export type Installed = { name: string; kind: RegistryKind; path: string };

/**
 * Downloads an entry and returns what would be written, without writing it.
 *
 * Separated from the write so the caller can show the user a skill body before it
 * becomes part of every future prompt.
 */
export async function stage(entry: RegistryEntry): Promise<{ path: string; content: string; preview: string }> {
  const body = await fetchText(entry.url, MAX_BODY_BYTES);

  if (entry.kind === 'plugin') {
    const manifest = parseManifest(body);
    if (manifest.name !== entry.name) {
      throw new Error(`the manifest calls itself "${manifest.name}" but the index calls it "${entry.name}"`);
    }
    const rules = manifest.deny
      .map((r) => `- denies ${r.tools.join(', ')}: ${r.pathPattern ?? r.commandPattern}`)
      .join('\n');
    return {
      path: join(pluginsDir(), `${entry.name}.json`),
      content: JSON.stringify(manifest, null, 2),
      preview: `${manifest.description}\n\n${rules}`,
    };
  }

  const skill = parseSkill(body, 'registry');
  if (!skill) throw new Error('that skill has no name/description frontmatter, so it cannot be loaded');
  if (skill.name !== entry.name) {
    throw new Error(`the skill calls itself "${skill.name}" but the index calls it "${entry.name}"`);
  }

  return { path: join(skillsDir(), `${entry.name}.md`), content: body, preview: skill.body };
}

export async function install(entry: RegistryEntry): Promise<Installed> {
  const { path, content } = await stage(entry);
  await Bun.write(path, content);
  return { name: entry.name, kind: entry.kind, path };
}

/** Removes an installed entry. Returns false when there was nothing to remove. */
export async function uninstall(kind: RegistryKind, name: string): Promise<boolean> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`"${name}" is not a valid entry name`);
  const path = kind === 'plugin' ? join(pluginsDir(), `${name}.json`) : join(skillsDir(), `${name}.md`);
  const file = Bun.file(path);
  if (!(await file.exists())) return false;
  await file.delete();
  return true;
}

/**
 * Declarative plugins from disk.
 *
 * A malformed file is reported and skipped rather than fatal: one bad install
 * should not stop the agent from starting.
 */
export async function loadInstalledPlugins(): Promise<{ plugins: Plugin[]; errors: { plugin: string; message: string }[] }> {
  const plugins: Plugin[] = [];
  const errors: { plugin: string; message: string }[] = [];

  let files: string[] = [];
  try {
    for await (const f of new Bun.Glob('*.json').scan({ cwd: pluginsDir(), onlyFiles: true })) files.push(f);
  } catch {
    return { plugins, errors };
  }

  for (const file of files.sort()) {
    const name = file.replace(/\.json$/, '');
    try {
      plugins.push(manifestToPlugin(parseManifest(await Bun.file(join(pluginsDir(), file)).text())));
    } catch (e) {
      errors.push({ plugin: name, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return { plugins, errors };
}

/** Installed skills, for `/registry list` — the loader already merges them by name. */
export function installedSkillNames(skills: Skill[]): string[] {
  return skills.filter((s) => s.origin === 'registry').map((s) => s.name);
}
