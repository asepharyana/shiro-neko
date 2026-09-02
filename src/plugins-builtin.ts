import { tool } from 'ai';
import { z } from 'zod';
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

export const BUILTIN_PLUGINS: Plugin[] = [guardPlugin, bellPlugin, timePlugin];

/** Enabled unless the config turns them off. bell is opt-in; a bell per turn is intrusive. */
export const DEFAULT_ENABLED = ['guard', 'time'];

export { DESTRUCTIVE };
