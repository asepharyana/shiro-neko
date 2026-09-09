import { costOf, formatUsd, PRICING_VERIFIED_AT } from '../pricing';
import type { Session } from '../session';
import { toolSetOf } from '../tools';
import { todoLines } from './transcript';

export type Panel = { title: string; hint?: string; body: string };

/**
 * The read-only panel bodies, as pure functions of session and hook state.
 *
 * These were inline inside App's submit switch, where each one added a `setPanel`
 * call wrapped around string assembly and pushed the switch past the point a reader
 * can follow it. Out here they are testable without mounting Ink, and the switch
 * reads as routing rather than as formatting.
 */

export function toolsPanel(session: Session): Panel {
  const offered = session.activeTools().sort();
  return {
    title: 'tools',
    hint: `${offered.length} offered this turn of ${Object.keys(session.tools).length} registered`,
    body: offered
      .map((t) => {
        const set = toolSetOf(t);
        return `- \`${t}\`${set ? `  ${set}` : ''}`;
      })
      .join('\n'),
  };
}

export function costPanel(
  session: Session,
  info: { sessionId: string; model: string; agent: string; thinking: string; subagentModel?: string },
): Panel {
  const spend = costOf(info.model, session.inputTokens, session.outputTokens);
  const lines = [
    `- model: \`${info.model}\``,
    `- billed: ${session.inputTokens} in / ${session.outputTokens} out`,
    `- spend: ${spend === undefined ? 'unpriced model' : formatUsd(spend)}`,
  ];

  // Subagent spend is priced against its own model id, which may be the cheaper
  // one, so it is reported as its own line rather than folded into the parent's.
  if (session.subagentInputTokens + session.subagentOutputTokens > 0) {
    const subModel = info.subagentModel ?? info.model;
    const subSpend = costOf(subModel, session.subagentInputTokens, session.subagentOutputTokens);
    lines.push(
      `- subagents: ${session.subagentInputTokens} in / ${session.subagentOutputTokens} out (\`${subModel}\`)${
        subSpend === undefined ? '' : ` - ${formatUsd(subSpend)}`
      }`,
    );
  }

  const ceiling = session.spend();
  if (ceiling.ceiling !== undefined) {
    lines.push(
      `- ceiling: ${ceiling.usd === undefined ? 'unpriced' : formatUsd(ceiling.usd)} of ${formatUsd(ceiling.ceiling)}`,
    );
  }
  const perTurn = session.maxSpendPerTurn();
  if (perTurn !== undefined) {
    lines.push(`- per-turn cap: ${formatUsd(perTurn)}`);
  }
  const cache = session.promptCacheStats();
  if (cache.hits + cache.misses > 0) {
    lines.push(`- prompt cache: ${cache.hits} hits / ${cache.misses} misses`);
  }

  lines.push(`- context: ~${session.estimatedTokens()} tokens (est.)`, `- agent: \`${info.agent}\` thinking \`${info.thinking}\``);
  lines.push(`- pricing verified: ${PRICING_VERIFIED_AT} (est., verify before billing)`);
  return { title: 'cost', hint: `session ${info.sessionId}`, body: lines.join('\n') };
}

export function contextPanel(files: readonly string[]): Panel {
  const tracker = files.filter((f) => f.endsWith('TODO.md') || f.endsWith('ROADMAP.md'));
  const instructions = files.filter((f) => !tracker.includes(f));
  const body: string[] = [];
  if (instructions.length > 0) body.push('instructions:', ...instructions.map((f) => `- \`${f}\``));
  if (tracker.length > 0) body.push('trackers:', ...tracker.map((f) => `- \`${f}\``));
  if (body.length === 0) {
    body.push('No `AGENTS.md`, `CLAUDE.md`, or `.shiro.md` found. Run `/init` to write one.');
    body.push('No `TODO.md` or `ROADMAP.md` found — no project tracker is loaded.');
  }
  return { title: 'project instructions & trackers', body: body.join('\n') };
}

export const todosPanel = (session: Session): Panel => ({
  title: 'task list',
  body: todoLines(session.notebook.state().todos),
});

const renderChangeList = (kind: string, paths: string[]): string =>
  paths.length === 0 ? '' : `${kind}:\n${paths.map((p) => `- ${p}`).join('\n')}`;

/** What the last turn changed on disk — the file side of /undo, without undoing. */
export function changesPanel(session: Session): Panel {
  const summary = session.lastTurnSummary();
  if (!summary) return { title: 'changes', body: 'the last turn changed no files (bash effects are not tracked)' };
  const body = [
    renderChangeList('added', summary.added),
    renderChangeList('modified', summary.modified),
    renderChangeList('deleted', summary.deleted),
  ]
    .filter(Boolean)
    .join('\n');
  return { title: 'changes', body };
}

/** Project workflow state: what the repo tracks and how the session behaved. */
export function workflowPanel(session: Session): Panel {
  const w = session.workflowStatus();
  const yes = (b: boolean): string => (b ? 'yes' : 'no');
  const rows = [
    ['workflow', w.enabled ? 'on' : 'off'],
    ['TODO.md', `${yes(w.hasTodo)}${w.hasTodo ? ` (${w.todoLines} lines)` : ''}`],
    ['ROADMAP.md', `${yes(w.hasRoadmap)}${w.hasRoadmap ? ` (${w.roadmapLines} lines)` : ''}`],
    ['docs dir', `${yes(w.hasDocs)}${w.hasDocs ? ` (${w.docsFiles} files)` : ''}`],
    ['reminders sent', w.nudgeCount === 0 ? 'none' : `${w.nudgeCount}/3`],
  ];
  const body = rows.map(([k, v]) => `${k}: ${v}`).join('\n');
  return { title: 'workflow', body };
}
