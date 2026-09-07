import { tool } from 'ai';
import { z } from 'zod';
import { posix } from './ignore';
import type { Plugin } from './plugins';

/**
 * Commands that destroy work irreversibly. Approval alone is a weak defence here:
 * a user holding `a` for a batch of edits will approve one of these without reading it,
 * so they are refused outright and the user has to run them by hand.
 */
const DESTRUCTIVE: { re: RegExp; why: string }[] = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf]/, why: 'recursive or forced delete' },
  { re: /\bgit\s+reset\s+--hard\b/, why: 'discards uncommitted work' },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*f/, why: 'deletes untracked files' },
  { re: /\bgit\s+push\b.*(--force\b|--force-with-lease\b|\s-f\b)/, why: 'rewrites remote history' },
  { re: /\bgit\s+branch\s+-D\b/, why: 'deletes a branch without a merge check' },
  { re: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, why: 'destroys database data' },
  { re: /\bmkfs(\.\w+)?\b|\bdd\s+[^|]*of=\/dev\//, why: 'writes to a raw device' },
  { re: />\s*\/dev\/(sd|nvme|disk)/, why: 'writes to a raw device' },
  { re: /\bchmod\s+(-[a-zA-Z]*\s+)*777\b/, why: 'makes files world-writable' },
  { re: /\b(shutdown|reboot|halt)\b/, why: 'affects the whole machine' },
  { re: /:\(\)\s*\{.*\}\s*;\s*:/, why: 'fork bomb' },
  { re: /\bcurl\b[^|]*\|\s*(ba|z|k)?sh\b|\bwget\b[^|]*\|\s*(ba|z|k)?sh\b/, why: 'pipes a download straight into a shell' },
];

export const guardPlugin: Plugin = {
  name: 'guard',
  description: 'refuses irreversible shell commands outright',
  appendix:
    'The guard plugin refuses irreversible shell commands (recursive deletes, hard resets, force pushes, ' +
    'DROP TABLE, piping downloads into a shell). If one is refused, do not work around it: tell the user ' +
    'what needs running and let them do it themselves.',
  beforeToolCall: ({ toolName, input }) => {
    if (toolName !== 'bash') return undefined;
    const command = String((input as { command?: unknown } | null)?.command ?? '');
    if (!command) return undefined;
    for (const { re, why } of DESTRUCTIVE) {
      if (re.test(command)) {
        return `refusing "${command.slice(0, 120)}" (${why}). Ask the user to run it themselves if it is really needed.`;
      }
    }
    return undefined;
  },
};

export const bellPlugin: Plugin = {
  name: 'bell',
  description: 'rings the terminal bell when a turn ends',
  afterTurn: () => {
    process.stderr.write('\u0007');
  },
};

export const timePlugin: Plugin = {
  name: 'time',
  description: 'adds a current_time tool',
  autoApprove: ['current_time'],
  tools: {
    current_time: tool({
      description: 'Current date and time in ISO 8601, with the local timezone. Use it when the date matters.',
      inputSchema: z.object({}),
      execute: async () => {
        const now = new Date();
        return `${now.toISOString()} (local: ${now.toString()})`;
      },
    }),
  },
};

/**
 * Paths that hold credentials.
 *
 * The permission defaults already refuse to *read* these. This refuses to write
 * them, which is a different failure: a model asked to "add the API key to the env
 * file" will do exactly that, and a secret committed by an agent is a secret to
 * rotate. The user writes their own credentials.
 */
const SECRET_PATHS: { re: RegExp; why: string }[] = [
  // `.env.example` holds placeholders by convention and is the one such file a
  // model legitimately writes, so it is excluded here rather than by a later rule.
  { re: /(^|[\\/])\.env(?!\.example$)(\.|$)/i, why: 'an env file' },
  { re: /\.(pem|key|p12|pfx|jks|keystore)$/i, why: 'a key or certificate' },
  { re: /(^|[\\/])(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.pub)?$/i, why: 'an SSH key' },
  { re: /(^|[\\/])\.(npmrc|pypirc|netrc|pgpass)$/i, why: 'a registry or database credential file' },
  { re: /(^|[\\/])(credentials|secrets?)\.(json|ya?ml|toml|ini)$/i, why: 'a credentials file' },
  { re: /(^|[\\/])\.aws[\\/]/i, why: 'an AWS credential directory' },
  { re: /(^|[\\/])\.ssh[\\/]/i, why: 'an SSH directory' },
  { re: /(^|[\\/])\.gnupg[\\/]/i, why: 'a GPG directory' },
];

/** Every path a write tool might carry, including a patch's markers and a move's ends. */
function writtenPaths(toolName: string, input: unknown): string[] {
  const o = (input ?? {}) as Record<string, unknown>;

  if (toolName === 'apply_patch') {
    const patch = typeof o['patch'] === 'string' ? o['patch'] : '';
    return [
      ...[...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]!.trim()),
      ...[...patch.matchAll(/^\*\*\* Move to: (.+)$/gm)].map((m) => m[1]!.trim()),
    ];
  }

  if (toolName === 'move_file') {
    return [o['from'], o['to']].filter((p): p is string => typeof p === 'string');
  }

  return typeof o['path'] === 'string' ? [o['path']] : [];
}

/** Write tools a path-based guard has to cover. Missing one is a silent bypass. */
const WRITE_TOOLS = ['write_file', 'edit_file', 'multi_edit', 'apply_patch', 'move_file', 'delete_file'];

export const secretsPlugin: Plugin = {
  name: 'secrets',
  description: 'refuses to write credential files',
  appendix:
    'The secrets plugin refuses writes to env files, keys, and credential stores. If one needs a value, tell the ' +
    'user which file and which key, and let them write it themselves. Do not work around the refusal by writing ' +
    'the same content somewhere else.',
  beforeToolCall: ({ toolName, input }) => {
    if (!WRITE_TOOLS.includes(toolName)) return undefined;

    for (const path of writtenPaths(toolName, input)) {
      for (const { re, why } of SECRET_PATHS) {
        if (re.test(path)) {
          return `refusing to write ${path} (${why}). Tell the user what to put there and let them write it.`;
        }
      }
    }
    return undefined;
  },
};

/**
 * Paths a write must not touch, for reasons other than secrecy.
 *
 * These are not credentials, so the secrets plugin has nothing to say about them.
 * They are files whose contents are owned by a tool rather than by anyone editing
 * them by hand: git's own object store, a resolver's lockfile, an installed
 * dependency tree, a build directory. A model editing one of these produces a
 * repository that looks fine and behaves wrongly, and the failure surfaces
 * somewhere else entirely.
 */
const PROTECTED_PATHS: { re: RegExp; why: string }[] = [
  { re: /(^|[\\/])\.git[\\/]/i, why: "git's own object store" },
  {
    re: /(^|[\\/])(bun\.lock|bun\.lockb|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|uv\.lock|composer\.lock|go\.sum|Gemfile\.lock)$/i,
    why: 'a lockfile the package manager owns',
  },
  { re: /(^|[\\/])node_modules[\\/]/i, why: 'an installed dependency' },
  { re: /(^|[\\/])(vendor|target[\\/]debug|target[\\/]release)[\\/]/i, why: 'a vendored or build directory' },
  { re: /(^|[\\/])(dist|build|out|\.next|\.nuxt|\.svelte-kit|coverage)[\\/]/i, why: 'generated build output' },
  { re: /(^|[\\/])\.(venv|tox|mypy_cache|pytest_cache|ruff_cache|turbo|parcel-cache)[\\/]/i, why: 'a tool cache' },
];

export const protectPlugin: Plugin = {
  name: 'protect',
  description: 'refuses writes to lockfiles, .git, dependencies, and build output',
  appendix:
    'The protect plugin refuses writes to .git, lockfiles, node_modules, vendored code, and build output. A ' +
    'lockfile is regenerated by its package manager: run the install or update command through bash instead of ' +
    'editing the file. Generated output is regenerated by its build. Do not route around the refusal.',
  beforeToolCall: ({ toolName, input }) => {
    if (!WRITE_TOOLS.includes(toolName)) return undefined;

    for (const path of writtenPaths(toolName, input)) {
      for (const { re, why } of PROTECTED_PATHS) {
        if (re.test(posix(path))) {
          return `refusing to write ${path} (${why}). Regenerate it with the tool that owns it rather than editing it.`;
        }
      }
    }
    return undefined;
  },
};

const FORMATTERS: { file: string; script: string; command: string[] }[] = [
  { file: 'package.json', script: 'format', command: ['bun', 'run', 'format'] },
  { file: 'Cargo.toml', script: '', command: ['cargo', 'fmt'] },
  { file: 'go.mod', script: '', command: ['gofmt', '-w', '.'] },
];

/**
 * Runs the project's own formatter once a turn ends, if it has one.
 *
 * Off by default. It is useful — a diff without formatting noise reviews faster —
 * but it writes to files after the approvals for that turn are over, which is a
 * boundary worth crossing only on purpose.
 *
 * It runs the script the project already defines rather than shipping opinions
 * about style. No `package.json` `format` script means nothing happens.
 */
export const formatPlugin: Plugin = {
  name: 'format',
  description: "runs the project's own formatter after each turn",
  afterTurn: async () => {
    for (const { file, script, command } of FORMATTERS) {
      const manifest = Bun.file(file);
      if (!(await manifest.exists())) continue;

      if (script) {
        try {
          const pkg = (await manifest.json()) as { scripts?: Record<string, string> };
          if (!pkg.scripts?.[script]) continue;
        } catch {
          continue;
        }
      }

      try {
        const proc = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore', timeout: 60_000 });
        await proc.exited;
      } catch {
        // A missing binary is not worth interrupting the turn over.
      }
      return;
    }
  },
};

/**
 * Bash command patterns a guard refuses, shared by several small plugins.
 *
 * Each plugin owns one concern so it can be toggled alone; they are data (a name,
 * a pattern list, an appendix), never code beyond the matcher they all share.
 */
const bashRefusal = (patterns: { re: RegExp; why: string }[]) => {
  return ({ toolName, input }: Parameters<NonNullable<Plugin['beforeToolCall']>>[0]) => {
    if (toolName !== 'bash') return undefined;
    const command = String((input as { command?: unknown } | null)?.command ?? '');
    if (!command) return undefined;
    for (const { re, why } of patterns) {
      if (re.test(command)) return `refusing "${command.slice(0, 120)}" (${why}). Run it yourself if it is really needed.`;
    }
    return undefined;
  };
};

export const noForcePushPlugin: Plugin = {
  name: 'no-force-push',
  description: 'refuses any push that rewrites remote history',
  appendix: 'The no-force-push plugin refuses force pushes. Ask the user to run one by hand if it is truly intended.',
  beforeToolCall: bashRefusal([
    { re: /\bgit\s+push\b[^|]*(--force\b|--force-with-lease\b|\s-f\b)/, why: 'rewrites remote history' },
    { re: /\bgit\s+push\b[^|]*\s+\+/, why: 'a force push via refspec' },
  ]),
};

export const noMainCommitPlugin: Plugin = {
  name: 'no-main-commit',
  description: 'refuses to commit directly to main or master',
  appendix: 'The no-main-commit plugin refuses to commit to main/master. Create a branch and commit there instead.',
  beforeToolCall: bashRefusal([
    { re: /\bgit\s+(commit|merge)\b[^|]*\b(main|master)\b/, why: 'touches the default branch directly' },
    { re: /\bgit\s+checkout\s+(main|master)\b[^|]*&&[^|]*\bcommit\b/, why: 'commits on the default branch' },
  ]),
};

export const noRootPlugin: Plugin = {
  name: 'no-root',
  description: 'refuses commands run with sudo or as an elevated shell',
  appendix: 'The no-root plugin refuses sudo and elevation. Nothing the agent does should need it; ask the user to run it themselves.',
  beforeToolCall: bashRefusal([
    { re: /(^|\s)sudo\b/, why: 'elevated privileges' },
    { re: /\brunas\b|\bStart-Process\b[^|]*-Verb\s+RunAs/i, why: 'an elevated process' },
  ]),
};

export const noNetPipePlugin: Plugin = {
  name: 'no-net-pipe',
  description: 'refuses to execute anything downloaded straight into a shell',
  appendix: 'The no-net-pipe plugin refuses piping a download into an interpreter. Download, review the file, then run it.',
  beforeToolCall: bashRefusal([
    { re: /\b(curl|wget)\b[^|]*\|\s*(ba|z|k)?sh\b|\b(curl|wget)\b[^|]*\|\s*(node|python|ruby|perl|bun)\b/i, why: 'executes a download unseen' },
    { re: /\biex\b|\bInvoke-Expression\b[^|]*\b(iwr|Invoke-WebRequest|curl)\b/i, why: 'executes a download unseen' },
  ]),
};

export const noGitConfigPlugin: Plugin = {
  name: 'no-git-config',
  description: 'refuses to change git configuration or global state',
  appendix: 'The no-git-config plugin refuses to edit git config. Tell the user the exact config change to make themselves.',
  beforeToolCall: bashRefusal([
    { re: /\bgit\s+config\b[^|]*(--global|--system)/, why: 'changes global git configuration' },
    { re: /\bgit\s+config\b[^|]*(user\.(name|email)|core\.(sshCommand|editor|pager))\s+\S/, why: 'changes how git identifies or runs' },
  ]),
};

export const noEnvWritePlugin: Plugin = {
  name: 'no-env-write',
  description: 'refuses to print or export secrets into the shell environment',
  appendix: 'The no-env-write plugin refuses to export or echo credentials into the environment. The user sets their own secrets.',
  beforeToolCall: bashRefusal([
    { re: /\b(export|setx?)\s+[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*=/i, why: 'writes a credential into the environment' },
    { re: /\becho\b[^|]*\b(api[_-]?key|secret|token|password)\b[^|]*>>?\s*\S/i, why: 'writes a credential to a file' },
  ]),
};

export const conventionalCommitPlugin: Plugin = {
  name: 'conventional-commit',
  description: 'nudges commit messages toward the conventional format',
  appendix:
    'The conventional-commit plugin is advisory: write commit subjects as type(scope): summary, e.g. ' +
    '`fix(auth): reject expired tokens`. Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.',
};

export const testsFirstPlugin: Plugin = {
  name: 'tests-first',
  description: 'reminds the agent to pin behaviour with a failing test before fixing',
  appendix:
    'The tests-first plugin is advisory: for a bug, write or find the test that reproduces it before changing code. ' +
    'Watch it fail, then fix, then watch it pass. A fix without a failing-then-passing test is unverified.',
};

export const smallDiffsPlugin: Plugin = {
  name: 'small-diffs',
  description: 'reminds the agent to keep a change focused on one thing',
  appendix:
    'The small-diffs plugin is advisory: one change does one thing. Do not tidy, rename, or reformat outside the ' +
    'task. A diff that is hard to review is usually two diffs wearing one coat — split it.',
};

export const confirmDeletePlugin: Plugin = {
  name: 'confirm-delete',
  description: 'refuses delete calls that name broad or ambiguous paths',
  appendix: 'The confirm-delete plugin refuses deletes that name a directory or a wildcard. Delete one explicit file at a time.',
  beforeToolCall: ({ toolName, input }) => {
    if (toolName !== 'delete_file') return undefined;
    const path = String((input as { path?: unknown } | null)?.path ?? '');
    if (/[*?[\]]/.test(path) || path.endsWith('/') || path === '.' || path === '') {
      return `refusing to delete "${path}" (ambiguous or broad). Delete one explicit file.`;
    }
    return undefined;
  },
};

export const BUILTIN_PLUGINS: Plugin[] = [
  guardPlugin,
  secretsPlugin,
  protectPlugin,
  bellPlugin,
  timePlugin,
  formatPlugin,
  noForcePushPlugin,
  noMainCommitPlugin,
  noRootPlugin,
  noNetPipePlugin,
  noGitConfigPlugin,
  noEnvWritePlugin,
  conventionalCommitPlugin,
  testsFirstPlugin,
  smallDiffsPlugin,
  confirmDeletePlugin,
];

/**
 * Enabled unless the config turns them off.
 *
 * `guard`, `secrets`, and `protect` are refusals, so they are on: a user who has to
 * opt into a safety check does not have it. The four narrow safety refusals
 * (`no-force-push`, `no-net-pipe`, `no-root`, `no-env-write`) are on for the same
 * reason — each blocks a single irreversible class of mistake. `bell` and `format`
 * act on their own, and the advisory/opinionated plugins (`no-main-commit`,
 * `conventional-commit`, `tests-first`, `small-diffs`, `confirm-delete`,
 * `no-git-config`) encode a workflow preference, so all of those are opt-in.
 */
export const DEFAULT_ENABLED = ['guard', 'secrets', 'protect', 'time', 'no-force-push', 'no-net-pipe', 'no-root', 'no-env-write'];

export { DESTRUCTIVE, SECRET_PATHS, PROTECTED_PATHS };
