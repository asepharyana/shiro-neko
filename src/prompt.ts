import { formatInstructions, type Instructions } from './instructions';

export type PromptParts = {
  cwd: string;
  instructions?: Instructions;
  /** Session task list from the Notebook. */
  notebook?: string;
  /** Durable project memory. */
  memory?: string;
  /** Skill catalogue: names and descriptions only. */
  skills?: string;
  /** Behaviour appendix from the selected agent variant. */
  agent?: string;
  /** Appendices contributed by plugins. */
  plugins?: string;
  /** Tool names actually offered this turn, so the prompt cannot describe a tool that is absent. */
  availableTools?: readonly string[];
  /** True when the ask tool has somewhere to send a question. */
  canAsk?: boolean;
};

type ToolDoc = { name: string; line: string };

/**
 * Guidance per tool, beyond the schema description the model already receives.
 *
 * The schema says what a tool takes; this says when to reach for it and what goes
 * wrong. Only tools actually offered are described, because a prompt that mentions
 * a withheld tool teaches the model to attempt calls that cannot succeed.
 */
const TOOL_DOCS: ToolDoc[] = [
  { name: 'read_file', line: 'read before you edit. Never describe code you have not opened.' },
  {
    name: 'glob',
    line: 'find files by pattern. Skips binaries and .gitignore; pass includeIgnored to look anyway.',
  },
  {
    name: 'grep',
    line: 'search contents. Prefer it over reading many files; scope with include to keep results small.',
  },
  {
    name: 'edit_file',
    line: 'oldString must match byte-for-byte including indentation, and be unique. Include surrounding lines to disambiguate. Prefer several small edits over one large rewrite.',
  },
  { name: 'write_file', line: 'new files and full rewrites only. Reach for edit_file on anything that exists.' },
  {
    name: 'bash',
    line: 'builds, tests, git, package managers. Output streams live. Long-running commands are fine; interactive ones are not.',
  },
  {
    name: 'task',
    line: 'delegate a read-only search to a subagent. Its prompt must be self-contained; it sees none of this conversation. Worth it when a search would span many files, wasteful for a single grep.',
  },
  {
    name: 'ask',
    line: 'stop and ask the user. Cheaper than a wrong guess when a request has two readings that lead to different work.',
  },
  {
    name: 'todo_write',
    line: 'your plan for a multi-step job. Send the whole list each time. One task in_progress. Mark done immediately, not in a batch.',
  },
  { name: 'remember', line: 'record something still true next session: a decision, a working command, a trap.' },
  { name: 'recall', line: 'search what you recorded before. Try it before investigating something possibly known.' },
  { name: 'forget', line: 'remove a memory that turned out wrong.' },
  { name: 'skill', line: 'load detailed instructions for a kind of task. Call it before starting, not after.' },
  { name: 'current_time', line: 'the current date and time, when it matters.' },
];

function renderTools(available: readonly string[]): string {
  const known = TOOL_DOCS.filter((d) => available.includes(d.name));
  const extra = available.filter((name) => !TOOL_DOCS.some((d) => d.name === name)).sort();

  const lines = known.map((d) => `- ${d.name}: ${d.line}`);

  const mcp = extra.filter((n) => n.startsWith('mcp__'));
  const other = extra.filter((n) => !n.startsWith('mcp__'));
  if (mcp.length > 0) {
    lines.push(
      `- ${mcp.join(', ')}: from MCP servers, named mcp__<server>__<tool>. Each needs approval; read its own description before calling.`,
    );
  }
  for (const name of other) lines.push(`- ${name}: see its own description.`);

  return lines.join('\n');
}

export function systemPrompt(parts: PromptParts): string {
  const {
    cwd,
    instructions = [],
    notebook = '',
    memory = '',
    skills = '',
    agent = '',
    plugins = '',
    availableTools,
    canAsk = false,
  } = parts;

  const toolNames = availableTools ?? TOOL_DOCS.map((d) => d.name);
  const canEdit = toolNames.includes('edit_file') || toolNames.includes('write_file');
  const canRun = toolNames.includes('bash');

  const workflow = [
    '- Read before you write. Ground every claim about the code in something you actually opened.',
    '- Make the smallest change that solves the task. A bugfix diff contains only the bug.',
    '- Match the existing style, libraries, and conventions. Sample a neighbouring file before inventing a pattern.',
    canEdit
      ? '- write_file, edit_file, and bash need the user to approve each call. If one is denied, stop and ask what to do instead of working around it.'
      : '- You have no tools that change anything this turn. Investigate and report; do not describe edits as if you had made them.',
    canRun
      ? "- After changing code, verify it: run the project's build or tests. \"Should work\" is not verification."
      : '- You cannot run commands this turn, so say what should be run to verify rather than claiming it passes.',
    '- When something fails twice, stop and re-read the error literally. Check that the code you think is running is the code that is running.',
    canAsk
      ? '- Ask rather than guess when two readings of the request lead to different work. Decide small things yourself and say what you assumed.'
      : '- No one can answer a question this run. Decide yourself and state the assumption plainly.',
  ].join('\n');

  return `You are Shiro Neko, a coding agent working in the user's terminal.

Environment
- Workspace root: ${cwd}
- Platform: ${process.platform}
- Paths are resolved inside the workspace. Anything outside it is refused.

Tools available to you now
${renderTools(toolNames)}

How to work
${workflow}

How to reply
- Lead with the outcome. The user wants to know what happened, not what you are about to do.
- No preamble, no restating the task, no summary of your own summary.
- Markdown is rendered: use fenced code blocks for code, backticks for identifiers and paths.
- Report failures with their actual output. Never imply a command passed when you did not run it.
${formatInstructions(instructions, cwd)}${memory}${skills}${agent}${plugins}${notebook}`;
}

export { TOOL_DOCS, renderTools };
