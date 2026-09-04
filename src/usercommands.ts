import { join } from 'node:path';

/**
 * User-defined slash commands, loaded from a markdown file.
 *
 * Every comparable agent CLI has file-defined commands; this closes that gap.
 * A command is a `## <name>` heading followed by a body that is the prompt
 * template sent to the model. Distinct from built-ins, which live in commands.ts
 * as code. A user command whose name collides with a built-in is shadowed (the
 * built-in wins) so a project cannot hijack `/model` or `/help`.
 *
 * The body supports substitutions that make a static template useful:
 *   $ARGUMENTS  - everything typed after the command name, verbatim
 *   $1..$9      - the nth whitespace-separated argument (empty when absent)
 *   !`cmd`      - replaced with the trimmed stdout of running `cmd` in the shell
 *   @path       - replaced with the contents of the (workspace-rooted) file
 */

export type UserCommand = {
  name: string;
  summary: string;
  body: string;
};

export const commandFileName = () => 'commands.md';
export const commandFileDir = (cwd: string) => join(cwd, '.shiro');

/** Raw .ts/.tsx/.js source of a `!`cmd` successive expansion step. */
const SHELL = /!`((?:[^`\\]|\\.)*)`/g;
const FILE = /@([^\s"']+)/g;
const TAG = /\$(\d+|\{ARGS\}|ARGUMENTS)/g;

function trimBody(body: string): string {
  return body
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Parses the raw file text into commands. Exported for the test suite. */
export function parseUserCommands(text: string): UserCommand[] {
  const commands: UserCommand[] = [];
  let current: UserCommand | undefined;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    const heading = /^##\s+([^\s]+)/.exec(line);
    if (heading) {
      if (current) commands.push(current);
      const name = heading[1]!.toLowerCase();
      current = { name, summary: '', body: '' };
      continue;
    }
    if (!current) continue; // prose before the first heading is ignored
    if (current.summary === '' && current.body === '' && line.startsWith('>')) {
      current.summary = line.replace(/^>\s?/, '').trim();
      continue;
    }
    if (line === '---' || line === '```') {
      current.body += '\n';
      continue;
    }
    current.body += `${line}\n`;
  }
  if (current) commands.push(current);

  return commands.map((c) => ({ ...c, body: trimBody(c.body) }));
}

export async function loadUserCommands(cwd: string): Promise<UserCommand[]> {
  const file = Bun.file(join(commandFileDir(cwd), commandFileName()));
  if (!(await file.exists())) return [];
  try {
    return parseUserCommands(await file.text());
  } catch {
    return [];
  }
}

/**
 * Expands a command body against the typed arguments and workspace.
 *
 * Substitutions are applied in a safe order: shell reads first (they produce
 * text that may itself contain `$` or `@` that must not be re-read), then file
 * reads, then `$n` tags. `$ARGUMENTS` is the verbatim tail, `$n` the nth
 * whitespace term. A missing file or a failing shell line keeps its literal
 * text plus a bracketed note rather than throwing, so a stale command still
 * reaches the model with the failure visible.
 */
export async function expandCommand(
  cmd: UserCommand,
  args: string,
  cwd: string,
): Promise<string> {
  const terms = args.split(/\s+/).filter(Boolean);
  let out = await expandShell(cmd.body, cwd);
  out = await expandFiles(out, cwd);
  out = out.replace(TAG, (m, g: string) => {
    if (g === 'ARGUMENTS' || g === '{ARGS}') return args;
    const idx = Number(g);
    return terms[idx - 1] ?? '';
  });
  return out.trim();
}

async function expandShell(body: string, cwd: string): Promise<string> {
  const parts: string[] = [];
  let last = 0;
  for (const m of body.matchAll(SHELL)) {
    parts.push(body.slice(last, m.index));
    const command = m[1]!.trim();
    try {
      const proc = Bun.spawn(['bash', '-c', command], { cwd, stdout: 'pipe', stderr: 'pipe' });
      const stdoutPromise = new Response(proc.stdout).text();
      const exitedPromise = proc.exited;
      const stdout = await stdoutPromise;
      const code = await exitedPromise;
      parts.push(code === 0 ? stdout.trim() : `[!shell exit ${code}: ${command}]`);
    } catch (e) {
      parts.push(`[!shell failed: ${e instanceof Error ? e.message : String(e)}]`);
    }
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(body.slice(last));
  return parts.join('');
}

async function expandFiles(body: string, cwd: string): Promise<string> {
  const parts: string[] = [];
  let last = 0;
  for (const m of body.matchAll(FILE)) {
    parts.push(body.slice(last, m.index));
    const path = m[1]!;
    const file = Bun.file(join(cwd, path));
    if (await file.exists()) {
      try {
        parts.push((await file.text()).trimEnd());
      } catch {
        parts.push(`[@file unreadable: ${path}]`);
      }
    } else {
      parts.push(`[@file missing: ${path}]`);
    }
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(body.slice(last));
  return parts.join('');
}

export const USER_COMMAND_MARKER = '## ';
