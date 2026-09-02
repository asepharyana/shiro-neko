import { dirname, join, resolve } from 'node:path';

const NAMES = ['AGENTS.md', 'CLAUDE.md', '.shiro.md'];
/** Cap per file so one huge doc cannot crowd out the conversation. */
const MAX_CHARS = 12_000;

export type Instructions = { path: string; text: string }[];

/**
 * Collects project instruction files from the git root down to cwd, outermost
 * first so a nested file's rules read as refinements of the ones above it.
 * Stops at the git root, or the filesystem root when there is no repo.
 */
export async function loadInstructions(cwd = process.cwd()): Promise<Instructions> {
  const dirs: string[] = [];
  let dir = resolve(cwd);
  while (true) {
    dirs.unshift(dir);
    if (await Bun.file(join(dir, '.git', 'HEAD')).exists()) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const found: Instructions = [];
  const seen = new Set<string>();
  for (const d of dirs) {
    for (const name of NAMES) {
      const path = join(d, name);
      if (seen.has(path)) continue;
      const file = Bun.file(path);
      if (!(await file.exists())) continue;
      seen.add(path);
      const text = (await file.text()).trim();
      if (text) found.push({ path, text: text.slice(0, MAX_CHARS) });
    }
  }
  return found;
}

export function formatInstructions(instructions: Instructions, cwd = process.cwd()): string {
  if (instructions.length === 0) return '';
  const blocks = instructions.map(({ path, text }) => {
    const label = path.startsWith(cwd) ? path.slice(cwd.length + 1) || path : path;
    return `--- ${label} ---\n${text}`;
  });
  return [
    '',
    'Project instructions (from the files below). Treat these as standing orders from the user;',
    'they override your defaults but never your safety rules.',
    '',
    ...blocks,
  ].join('\n');
}

export const INSTRUCTION_NAMES = NAMES;

export const INIT_PROMPT = `Write an AGENTS.md at the workspace root that will orient a coding agent joining this project cold.

Investigate first: read the manifest, the config files, the entry points, and a couple of representative
source files. Run the test and build commands if that is the only way to learn how they are invoked.

Then write AGENTS.md covering only what you actually verified:
- what this project is, in two or three sentences
- the exact commands for install, build, test, typecheck, lint
- the layout: which directory holds what
- conventions a newcomer would otherwise get wrong: naming, error handling, module boundaries, test style
- anything surprising or easy to break

Keep it under 100 lines. No filler sections, no "best practices" boilerplate, nothing you did not confirm
by reading the code. If a section would be guesswork, leave it out.`;
