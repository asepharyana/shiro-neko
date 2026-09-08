import { tool, type ToolSet } from 'ai';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { jail } from './ignore';
import { manifestToPlugin, parseManifest, type PluginManifest } from './registry';
import type { Plugin } from './plugins';

/**
 * Auto-registration and auto-loading of external skills, tools, and plugins.
 *
 * Everything here is *data*, never code — the same rule the registry enforces.
 * An external tool is a bounded manifest (a shell template through the guard, an
 * HTTP fetch, or a file read), an external plugin a refusal manifest, an external
 * skill a markdown body. Loading arbitrary code from disk would let an entry read
 * every file the agent can read and lie about what it blocks, so it is not offered.
 *
 * Directories, later shadowing earlier by name:
 *   ~/.shiro-neko/{tools,plugins,skills}        (user)
 *   .shiro/{tools,plugins,skills}               (project)
 * Skills already load through skills.ts; this module adds tools and plugins and
 * the one place cli turns them all on.
 */

const home = () => process.env['SHIRO_HOME'] ?? homedir();

export type LoadError = { name: string; message: string };

function dirs(kind: 'tools' | 'plugins' | 'skills', cwd: string): string[] {
  return [join(home(), '.shiro-neko', kind), join(cwd, '.shiro', kind)];
}

async function scan(dir: string, ext: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const f of new Bun.Glob(`*.${ext}`).scan({ cwd: dir, onlyFiles: true })) files.push(f);
  } catch {
    return [];
  }
  return files.sort();
}

const MAX_PATTERN = 200;
const nameSchema = z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9-_]*$/i);

// ---------------------------------------------------------------------------
// External tools, as bounded manifests.
// ---------------------------------------------------------------------------

/**
 * Three kinds of tool, each with a ceiling on what it can do. None runs arbitrary
 * code: `shell` interpolates a fixed template and runs it through the guard and
 * the platform shell, `http` fetches a fixed URL, `read` returns a fixed file's
 * contents (jailed to the workspace). The input is a single optional `arg` string
 * substituted into a `{arg}` placeholder, so a manifest cannot take structure it
 * was not declared for.
 */
const toolManifestSchema = z.object({
  name: nameSchema,
  description: z.string().min(1).max(300),
  kind: z.enum(['shell', 'http', 'read']),
  /** The template with an optional `{arg}` placeholder. */
  command: z.string().max(500).optional(),
  url: z.string().max(500).optional(),
  path: z.string().max(300).optional(),
  /** Set false to require approval before running. Default true (auto-approved). */
  autoApprove: z.boolean().optional(),
});

export type ToolManifest = z.infer<typeof toolManifestSchema>;

export function parseToolManifest(source: string): ToolManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new Error('the tool manifest is not valid JSON');
  }
  const parsed = toolManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`the tool manifest is malformed: ${parsed.error.issues[0]?.message ?? 'unknown reason'}`);
  }
  const m = parsed.data;
  if (m.kind === 'shell' && !m.command) throw new Error(`shell tool "${m.name}" needs a command template`);
  if (m.kind === 'http' && !m.url) throw new Error(`http tool "${m.name}" needs a url`);
  if (m.kind === 'read' && !m.path) throw new Error(`read tool "${m.name}" needs a path`);
  return m;
}

const MAX_TOOL_OUTPUT = 30_000;
const cap = (s: string) => (s.length <= MAX_TOOL_OUTPUT ? s : `${s.slice(0, MAX_TOOL_OUTPUT)}\n... [truncated]`);

/** The guard an external shell tool runs through, supplied by cli so it shares the real chain. */
export type ShellGuard = (command: string) => Promise<string | undefined>;

/**
 * A manifest as a live tool. The guard is applied to every `shell` invocation, so
 * an external tool cannot smuggle a destructive command past the user any more
 * than a built-in bash call can.
 */
export function manifestToTool(manifest: ToolManifest, guard: ShellGuard) {
  const inputSchema = z.object({ arg: z.string().optional().describe('optional argument substituted into {arg}') });
  const substitute = (template: string, arg: string) => template.replaceAll('{arg}', arg);

  return tool({
    description: `${manifest.description} (external ${manifest.kind} tool)`,
    inputSchema,
    execute: async ({ arg = '' }) => {
      if (manifest.kind === 'read') {
        const abs = jail(substitute(manifest.path!, arg));
        const file = Bun.file(abs);
        if (!(await file.exists())) throw new Error(`no such file: ${manifest.path}`);
        return cap(await file.text());
      }

      if (manifest.kind === 'http') {
        const url = substitute(manifest.url!, arg);
        if (!/^https:\/\//i.test(url)) throw new Error(`http tools may only fetch https URLs, got: ${url}`);
        const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`${url} returned ${res.status}`);
        return cap(await res.text());
      }

      const command = substitute(manifest.command!, arg);
      const blocked = await guard(command);
      if (blocked) throw new Error(`refused: ${blocked}`);
      const shell = process.platform === 'win32' ? ['cmd', '/c', command] : ['bash', '-lc', command];
      const proc = Bun.spawn(shell, { stdout: 'pipe', stderr: 'pipe' });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) throw new Error(`exited ${code}: ${err.trim().slice(0, 300)}`);
      return cap(out.trim() || '(no output)');
    },
  });
}

export type ExternalTools = { tools: ToolSet; autoApprove: string[]; errors: LoadError[] };

/** Loads every external tool manifest, project shadowing user by name. Bad files are reported and skipped. */
export async function loadExternalTools(cwd: string, guard: ShellGuard): Promise<ExternalTools> {
  const tools: ToolSet = {};
  const autoApprove: string[] = [];
  const errors: LoadError[] = [];

  for (const dir of dirs('tools', cwd)) {
    for (const file of await scan(dir, 'json')) {
      const fallback = file.replace(/\.json$/i, '');
      try {
        const manifest = parseToolManifest(await Bun.file(join(dir, file)).text());
        tools[manifest.name] = manifestToTool(manifest, guard);
        if (manifest.autoApprove !== false) autoApprove.push(manifest.name);
      } catch (e) {
        errors.push({ name: fallback, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return { tools, autoApprove, errors };
}

// ---------------------------------------------------------------------------
// External plugins, as refusal manifests (same shape the registry installs).
// ---------------------------------------------------------------------------

export type ExternalPlugins = { plugins: Plugin[]; errors: LoadError[] };

/** Loads refusal-manifest plugins from disk, merging with any already installed via the registry. */
export async function loadExternalPlugins(cwd: string): Promise<ExternalPlugins> {
  const byName = new Map<string, Plugin>();
  const errors: LoadError[] = [];

  for (const dir of dirs('plugins', cwd)) {
    for (const file of await scan(dir, 'json')) {
      const fallback = file.replace(/\.json$/i, '');
      try {
        const manifest: PluginManifest = parseManifest(await Bun.file(join(dir, file)).text());
        byName.set(manifest.name, manifestToPlugin(manifest));
      } catch (e) {
        errors.push({ name: fallback, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return { plugins: [...byName.values()], errors };
}
