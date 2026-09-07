import { homedir } from 'node:os';
import { join } from 'node:path';
import { guardPlugin } from './plugins-builtin';

/**
 * Custom slash commands read from markdown files.
 *
 * `.shiro/commands/<name>.md` in the project and `~/.shiro-neko/commands/<name>.md`
 * for the user. The filename is the command; the body becomes the prompt. A project
 * command shadows a user command of the same name, so a repo can specialise a
 * personal default.
 */
export type CustomCommand = {
  name: string;
  /** One-line summary for the `/` menu, from frontmatter or the first body line. */
  description: string;
  /** Agent to run it under, when frontmatter sets one. */
  agent?: string;
  /** The prompt template, before substitution. */
  body: string;
  origin: 'project' | 'user';
  path: string;
};

const MAX_BODY = 20_000;

/** Reads frontmatter `description` and `agent`; everything after the `---` fence is the prompt. */
function parse(name: string, source: string, origin: CustomCommand['origin'], path: string): CustomCommand | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source.trimStart());
  const meta: Record<string, string> = {};
  let body = source;
  if (match) {
    for (const line of match[1]!.split(/\r?\n/)) {
      const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line.trim());
      if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.replace(/^["']|["']$/g, '').trim();
    }
    body = match[2]!;
  }
  const trimmed = body.trim().slice(0, MAX_BODY);
  if (!trimmed) return undefined;
  const description = meta['description'] ?? trimmed.split('\n').find((l) => l.trim().length > 0)?.trim().slice(0, 60) ?? name;
  return {
    name,
    description,
    ...(meta['agent'] ? { agent: meta['agent'] } : {}),
    body: trimmed,
    origin,
    path,
  };
}

function commandDirs(cwd: string): { dir: string; origin: CustomCommand['origin'] }[] {
  const home = join(process.env['SHIRO_HOME'] ?? homedir(), '.shiro-neko');
  return [
    { dir: join(home, 'commands'), origin: 'user' },
    { dir: join(cwd, '.shiro', 'commands'), origin: 'project' },
  ];
}

/** Loads every custom command, project shadowing user by name. A file that fails to parse is skipped. */
export async function loadCustomCommands(cwd = process.cwd()): Promise<CustomCommand[]> {
  const byName = new Map<string, CustomCommand>();
  for (const { dir, origin } of commandDirs(cwd)) {
    let files: string[] = [];
    try {
      for await (const f of new Bun.Glob('*.md').scan({ cwd: dir, onlyFiles: true })) files.push(f);
    } catch {
      continue;
    }
    for (const file of files.sort()) {
      const name = file.replace(/\.md$/i, '');
      if (!/^[a-z0-9][a-z0-9-_]*$/i.test(name)) continue;
      const path = join(dir, file);
      try {
        const cmd = parse(name, await Bun.file(path).text(), origin, path);
        if (cmd) byName.set(cmd.name, cmd);
      } catch {
        continue;
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Runs a `` !`cmd` `` substitution through the guard before executing it. */
async function runSubstitution(command: string): Promise<string> {
  const blocked = await guardPlugin.beforeToolCall!({ toolName: 'bash', input: { command }, cwd: process.cwd() });
  if (blocked) throw new Error(`shell substitution refused: ${blocked}`);

  // The same shell bash uses, so a substitution and a bash call agree on syntax.
  const shell = process.platform === 'win32' ? ['cmd', '/c', command] : ['bash', '-lc', command];
  const proc = Bun.spawn(shell, { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`shell substitution \`!${command}\` exited ${code}: ${err.trim().slice(0, 200)}`);
  return out.trim();
}

/**
 * Expands a command's body against the arguments it was typed with.
 *
 * `$ARGUMENTS` is the whole argument string, `$1`, `$2`, … the positionals, and
 * `` !`cmd` `` runs a shell command and inlines its output — each such command
 * passed through the guard first, so a custom command cannot smuggle a destructive
 * call past the user the way a plain bash call cannot.
 */
export async function expandCommand(cmd: CustomCommand, args: string[]): Promise<string> {
  let out = cmd.body;
  out = out.replaceAll('$ARGUMENTS', args.join(' '));
  out = out.replace(/\$(\d+)/g, (_, i) => args[Number(i) - 1] ?? '');

  const substitutions = [...out.matchAll(/!`([^`]+)`/g)];
  for (const m of substitutions) {
    const value = await runSubstitution(m[1]!);
    out = out.replace(m[0], value);
  }
  return out.trim();
}
