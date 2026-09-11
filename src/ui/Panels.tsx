import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import React, { useEffect, useState } from 'react';
import { TODO_MARK, type Todo } from '../notebook';
import type { SubagentKind } from '../subagent';
import { InlineMarkdown } from './Markdown';
import { accent, glyph, meter } from './theme';

const STATUS_COLOR: Record<Todo['status'], string | undefined> = {
  pending: undefined,
  in_progress: accent.user,
  done: accent.ok,
  blocked: accent.err,
};

/** Task list with a progress meter, shown above the input while a list exists. */
export function TodoPanel({ todos, width = 24 }: { todos: Todo[]; width?: number }) {
  const done = todos.filter((t) => t.status === 'done').length;
  const blocked = todos.filter((t) => t.status === 'blocked').length;
  const ratio = todos.length === 0 ? 0 : done / todos.length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent.mute} paddingX={1} marginBottom={1}>
      <Box>
        <Text bold color={accent.user}>
          tasks{' '}
        </Text>
        <Text color={accent.ok}>{meter(ratio, width)}</Text>
        <Text dimColor>{` ${done}/${todos.length}`}</Text>
        {blocked > 0 && <Text color={accent.err}>{`  ${glyph.blocked} ${blocked} blocked`}</Text>}
      </Box>
      {todos.map((t, i) => (
        <Box key={i}>
          <Text color={STATUS_COLOR[t.status]}>{`${TODO_MARK[t.status]} `}</Text>
          <Text dimColor={t.status === 'done'} strikethrough={t.status === 'done'}>
            {t.content}
          </Text>
          {t.note && <Text dimColor>{`  (${t.note})`}</Text>}
        </Box>
      ))}
    </Box>
  );
}

export type SubagentStep = {
  tool: string;
  summary: string;
  /** First line of the result, once it arrives. */
  outcome?: string;
  ok?: boolean;
};

export type SubagentView = {
  id: string;
  kind: SubagentKind;
  description: string;
  steps: SubagentStep[];
  status: 'running' | 'done' | 'failed';
  error?: string;
};

const KIND_LABEL: Record<SubagentKind, string> = { explore: 'explore', review: 'review', worker: 'worker' };

/** A worker can write, so its panel entry has to be distinguishable at a glance. */
const KIND_COLOUR: Record<SubagentKind, string> = { explore: accent.user, review: accent.info, worker: accent.warn };

/**
 * Live view of delegated work.
 *
 * A subagent can run for a minute over many files; without this the parent's spinner
 * is the only feedback and the user cannot tell progress from a hang. A `worker`
 * additionally changes the workspace, so its calls and their outcomes are shown
 * rather than just a step count.
 */
export function SubagentPanel({ agents, steps = 4 }: { agents: SubagentView[]; steps?: number }) {
  if (agents.length === 0) return null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent.tool} paddingX={1} marginBottom={1}>
      {agents.map((a) => (
        <Box key={a.id} flexDirection="column">
          <Box>
            {a.status === 'running' ? (
              <Text color={accent.tool}>
                <Spinner type="dots" />
              </Text>
            ) : (
              <Text color={a.status === 'done' ? accent.ok : accent.err}>
                {a.status === 'done' ? glyph.ok : glyph.err}
              </Text>
            )}
            <Text bold color={KIND_COLOUR[a.kind]}>{` ${KIND_LABEL[a.kind]}`}</Text>
            {a.kind === 'worker' && <Text color={accent.warn}>{' (writes)'}</Text>}
            <Text>{` ${glyph.sep} ${a.description}`}</Text>
            <Text dimColor>{`  ${a.steps.length} step${a.steps.length === 1 ? '' : 's'}`}</Text>
          </Box>
          {a.steps.slice(-steps).map((s, i) => (
            <Box key={i} flexDirection="column">
              <Text dimColor>{`    ${s.tool}(${s.summary.slice(0, 58)})`}</Text>
              {s.outcome !== undefined && (
                <Text color={s.ok === false ? accent.err : undefined} dimColor={s.ok !== false}>
                  {`      ${s.ok === false ? glyph.err : glyph.result} ${s.outcome}`}
                </Text>
              )}
            </Box>
          ))}
          {a.error && <Text color={accent.err}>{`    ${a.error}`}</Text>}
        </Box>
      ))}
    </Box>
  );
}

/** Elapsed time in the shortest form that still reads as a duration. */
const elapsed = (seconds: number) =>
  seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

/** Seconds before the count appears: a timer starting at 0s is noise, not feedback. */
const SLOW_AFTER = 10;

/**
 * The spinner line while the model works.
 *
 * The elapsed count starts only once a turn is slow enough to wonder about. Before
 * that it is a number nobody reads; after it, it is the difference between "this is
 * taking a while" and "has this hung?".
 */
export function Working({ seconds }: { seconds: number }) {
  return (
    <Text color={accent.warn}>
      <Spinner type="dots" />{' '}
      <Text dimColor>
        {seconds >= SLOW_AFTER ? `working ${elapsed(seconds)} ${glyph.sep} esc to interrupt` : `working ${glyph.sep} esc to interrupt`}
      </Text>
    </Text>
  );
}

/** Live tail of a running shell command. */
export function OutputPanel({ text, lines = 8 }: { text: string; lines?: number }) {
  if (text.length === 0) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {text
        .split('\n')
        .slice(-lines)
        .map((l, i) => (
          <Text key={i} dimColor>
            {`  ${glyph.sep} ${l}`}
          </Text>
        ))}
    </Box>
  );
}

/**
 * The tool call in flight, from tool-start until its result arrives.
 *
 * A read of a large file or a two-minute test run is otherwise indistinguishable
 * from a hang. The name arrives before the arguments finish streaming, so `detail`
 * is filled in a moment later; it is a list because one line rarely says enough —
 * a batch read is about to pull in twenty paths, and which twenty is the point.
 */
export function ActiveTool({ name, detail = [] }: { name: string; detail?: readonly string[] }) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={accent.tool}>
          <Spinner type="dots" />
        </Text>
        <Text bold color={accent.tool}>{` ${name}`}</Text>
        {detail[0] !== undefined && <Text dimColor>{`  ${detail[0]}`}</Text>}
      </Box>
      {detail.slice(1, 6).map((d, i) => (
        <Text key={i} dimColor>
          {`    ${d}`}
        </Text>
      ))}
      {detail.length > 6 && <Text dimColor>{`    ${glyph.fold} ${detail.length - 6} more`}</Text>}
    </Box>
  );
}

/**
 * The model's reasoning while it streams.
 *
 * Collapsed by default: it is progress, not the answer, and expanding it by default
 * would bury the reply. The token count is an estimate from character length, which
 * is close enough to tell a long think from a short one.
 */
export function ThinkingPanel({ text, expanded, lines = 8 }: { text: string; expanded?: boolean; lines?: number }) {
  if (text.length === 0) return null;
  const tokens = Math.round(text.length / 4);

  if (!expanded) {
    return <Text dimColor>{`thinking ${glyph.fold} ~${tokens} tokens ${glyph.sep} ctrl-r to expand`}</Text>;
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>{`thinking  ~${tokens} tokens ${glyph.sep} ctrl-r to collapse`}</Text>
      {text
        .split('\n')
        .slice(-lines)
        .map((l, i) => (
          <Text key={i} dimColor italic>
            {`  ${l}`}
          </Text>
        ))}
    </Box>
  );
}

/** Prompts typed during a turn, waiting their place in line. */
export function QueuePanel({ prompts }: { prompts: readonly string[] }) {
  if (prompts.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Text color={accent.user}>{`${glyph.queued} queued: ${prompts.length}`}</Text>
      {prompts.map((p, i) => (
        <Text key={i} dimColor>
          {`  ${i + 1}. ${p.length > 70 ? `${p.slice(0, 70)}…` : p}`}
        </Text>
      ))}
    </Box>
  );
}

/** Path picker for an `@` token, narrowing as the query grows. */
export function FileMenu({
  paths,
  index,
  query,
  loading,
}: {
  paths: readonly string[];
  index: number;
  query: string;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <Box marginTop={1}>
        <Text dimColor>indexing files…</Text>
      </Box>
    );
  }

  if (paths.length === 0) {
    return (
      <Box marginTop={1}>
        <Text dimColor>{`no file matches ${query || '@'}`}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {paths.map((p, i) => (
        <Text key={p} color={i === index ? accent.user : undefined} dimColor={i !== index}>
          {i === index ? `${glyph.user} ` : '  '}
          {p}
        </Text>
      ))}
      <Text dimColor>{`↑↓ move ${glyph.sep} tab/enter insert ${glyph.sep} esc dismiss`}</Text>
    </Box>
  );
}

/**
 * The persistent status line under the input.
 *
 * Three glance groups separated by quiet pipes: what is running (model, agent,
 * thinking), how full the context is (a meter plus a percentage), and what it has
 * cost. The context meter is the one piece of live information that changes
 * mid-session, so it is the only element with a bar; everything else stays text so
 * the bar is the thing the eye lands on.
 */
export function StatusBar({
  model,
  agent,
  thinking,
  contextTokens,
  contextLimit,
  cost,
  toolCount,
}: {
  model: string;
  agent: string;
  thinking: string;
  contextTokens: number;
  /** Threshold compaction fires at, so the bar means something. */
  contextLimit?: number;
  cost: string;
  toolCount: number;
}) {
  const pct = contextLimit ? Math.min(100, Math.round((contextTokens / contextLimit) * 100)) : undefined;
  // Amber from two thirds, red once compaction is imminent: the point is to warn
  // before a turn silently loses its history, not after. Past 90 the colour is
  // backed by words, because a reader watching the transcript is not watching this.
  const contextColor = pct === undefined ? undefined : pct >= 90 ? accent.err : pct >= 66 ? accent.warn : undefined;
  const sep = <Text dimColor>{` ${glyph.sep} `}</Text>;

  return (
    <Box>
      <Text dimColor>{model}</Text>
      {sep}
      <Text color={accent.user}>{agent}</Text>
      <Text dimColor>{`/${thinking}`}</Text>
      {sep}
      <Text dimColor>{`${toolCount} tools`}</Text>
      {sep}
      <Text color={contextColor} dimColor={contextColor === undefined}>
        {pct === undefined ? `~${contextTokens} ctx` : `${meter(pct / 100, 8)} ${pct}%`}
      </Text>
      {pct !== undefined && pct >= 90 && <Text color={accent.err}>{' compacting soon'}</Text>}
      {sep}
      <Text dimColor>{cost}</Text>
    </Box>
  );
}

/**
 * The one-line identity row inside the input box, OpenCode-style.
 *
 * Agent and model are the two things a prompt is answered *by*, so they sit
 * directly under the cursor rather than in a footer the eye has to travel to.
 * `right` carries the quieter facts (tool count, thinking level) pushed to the
 * far edge of the box, so the row reads as two anchored groups.
 */
export function InputStatus({
  agent,
  model,
  right,
  width,
}: {
  agent: string;
  model: string;
  right?: string;
  width: number;
}) {
  const left = ` ${agent} · ${model}`;
  const rightText = right ? `${right} ` : '';
  const gap = Math.max(1, width - left.length - rightText.length);
  return (
    <Box>
      <Text color={accent.user} bold>
        {agent}
      </Text>
      <Text dimColor>{` ${glyph.info} ${model}`}</Text>
      <Text dimColor>{' '.repeat(gap)}</Text>
      {right !== undefined && <Text dimColor>{right}</Text>}
      <Text> </Text>
    </Box>
  );
}

/**
 * The full-width footer beneath the input, OpenCode-style.
 *
 * Key hints live on the left (what you can press), the live numbers on the right
 * (context and cost). Spreading them to opposite edges means neither has to
 * compete for the same glance, and the meter stays the most saturated thing on
 * the line so the eye finds it first when a turn runs long.
 */
export function Footer({
  busy,
  contextTokens,
  contextLimit,
  cost,
  width,
}: {
  busy: boolean;
  contextTokens: number;
  contextLimit?: number;
  cost: string;
  width: number;
}) {
  const pct = contextLimit ? Math.min(100, Math.round((contextTokens / contextLimit) * 100)) : undefined;
  const contextColor = pct === undefined ? undefined : pct >= 90 ? accent.err : pct >= 66 ? accent.warn : undefined;
  const hint = busy ? `${glyph.bullet} esc interrupt` : `/ commands  ${glyph.sep}  @ files  ${glyph.sep}  ↑ history`;
  const right =
    pct === undefined ? `~${contextTokens} ctx ${glyph.sep} ${cost}` : `${meter(pct / 100, 8)} ${pct}% ${glyph.sep} ${cost}`;
  const gap = Math.max(1, width - hint.length - right.length - 1);

  return (
    <Box>
      <Text dimColor>{hint}</Text>
      <Text>{' '.repeat(gap)}</Text>
      <Text color={contextColor} dimColor={contextColor === undefined}>
        {right}
      </Text>
      {pct !== undefined && pct >= 90 && <Text color={accent.err}>{' compacting soon'}</Text>}
    </Box>
  );
}

/**
 * A bordered panel with a coloured label header, OpenCode's sidebar grammar.
 *
 * Used for the welcome dashboard's grouped facts (capabilities, project, meta).
 * The label carries the accent; the rows stay quiet, so a stack of these reads
 * as labelled groups rather than as more transcript.
 */
export function SidePanel({
  label,
  children,
  width,
  tone = accent.ok,
}: {
  label: string;
  children: React.ReactNode;
  width?: number;
  tone?: string;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={accent.mute}
      paddingX={1}
      marginBottom={1}
      {...(width !== undefined ? { width } : {})}
    >
      <Text color={tone} bold>
        {label}
      </Text>
      {children}
    </Box>
  );
}

/** One `name value` row inside a SidePanel, name padded so a stack aligns. */
export function SideRow({ name, value, nameWidth = 12, dim = true }: { name: string; value: string; nameWidth?: number; dim?: boolean }) {
  return (
    <Box>
      <Text dimColor={dim}>{name.padEnd(nameWidth)}</Text>
      <Text>{value}</Text>
    </Box>
  );
}

export type PanelLine = { label: string; value: string };

/** Bordered popup for a command's output, e.g. /skills or /cost. */
export function InfoPanel({ title, hint, lines }: { title: string; hint?: string; lines: PanelLine[] | string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent.user} paddingX={1} marginBottom={1}>
      <Box>
        <Text color={accent.user} bold>
          {title}
        </Text>
        {hint && <Text dimColor>{`  ${hint}`}</Text>}
      </Box>
      {typeof lines === 'string' ? (
        <InlineMarkdown text={lines} />
      ) : (
        lines.map((l, i) => (
          <Box key={i}>
            <Text color={accent.mute}>{l.label.padEnd(14)}</Text>
            <Text>{l.value}</Text>
          </Box>
        ))
      )}
      <Text dimColor>esc to dismiss</Text>
    </Box>
  );
}

import { diagStatus } from '../diagnostics';

/**
 * Live diagnostics: a bounded panel showing a background check command's output.
 *
 * Unlike InfoPanel (static snapshot), this re-reads diagStatus() on every render
 * tick driven by the App's 200ms interval, so its tail text updates live without
 * entering model context.
 */
export function DiagnosticsPanel({ command, startedAt }: { command: string; startedAt: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 200);
    return () => clearInterval(id);
  }, []);

  const snap = diagStatus();
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  const tail = snap.tail.split('\n').slice(-12).join('\n');

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent.tool} paddingX={1} marginBottom={1}>
      <Box>
        <Text color={accent.tool} bold>
          diagnostics
        </Text>
        <Text dimColor>{`  ${snap.running ? 'running' : `exit ${snap.exit}`}  ${elapsedStr}  ${glyph.sep} /diagnostics stop`}</Text>
      </Box>
      <Text dimColor>{`$ ${command}`}</Text>
      {tail ? (
        tail.split('\n').map((l, i) => (
          <Text key={i} dimColor>
            {`  ${l}`}
          </Text>
        ))
      ) : (
        <Text dimColor>{'  waiting for output...'}</Text>
      )}
    </Box>
  );
}

export type RegistryRow = {
  name: string;
  kind: 'skill' | 'plugin';
  description: string;
  author?: string;
  installed?: boolean;
};

const KIND_COLOR: Record<RegistryRow['kind'], string> = { skill: accent.ok, plugin: accent.tool };

/**
 * The registry index as a table.
 *
 * `kind` is coloured rather than spelled out on every row: skill and plugin carry
 * very different risk, and a reader scanning the list should see that at a glance.
 */
export function RegistryPanel({
  rows,
  hint,
  title = 'registry',
}: {
  rows: readonly RegistryRow[];
  hint?: string;
  title?: string;
}) {
  if (rows.length === 0) {
    return <InfoPanel title={title} {...(hint ? { hint } : {})} lines="nothing found" />;
  }

  const width = Math.min(22, Math.max(...rows.map((r) => r.name.length)) + 1);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent.user} paddingX={1} marginBottom={1}>
      <Box>
        <Text color={accent.user} bold>
          {title}
        </Text>
        {hint && <Text dimColor>{`  ${hint}`}</Text>}
      </Box>
      {rows.map((r) => (
        <Box key={`${r.kind}:${r.name}`}>
          <Text color={KIND_COLOR[r.kind]}>{r.kind === 'skill' ? 'S' : 'P'} </Text>
          <Text bold>{r.name.padEnd(width)}</Text>
          <Text dimColor>{r.description.length > 58 ? `${r.description.slice(0, 58)}…` : r.description}</Text>
          {r.installed && <Text color={accent.ok}>{`  ${glyph.ok} installed`}</Text>}
        </Box>
      ))}
      <Text dimColor>{`S skill  P plugin  ${glyph.sep}  /registry add <name>  ${glyph.sep}  esc to dismiss`}</Text>
    </Box>
  );
}

/**
 * Confirmation before an install writes anything.
 *
 * A skill body becomes part of the system prompt of every future session in this
 * project, so it is shown in full first. The wording says that plainly rather than
 * asking a generic "are you sure".
 */
export function InstallPrompt({
  name,
  kind,
  url,
  preview,
  lines = 14,
}: {
  name: string;
  kind: 'skill' | 'plugin';
  url: string;
  preview: string;
  lines?: number;
}) {
  const body = preview.split('\n');
  const shown = body.slice(0, lines);
  const hidden = body.length - shown.length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent.warn} paddingX={1}>
      <Text color={accent.warn} bold>
        {`install ${kind} "${name}"?`}
      </Text>
      <Text dimColor>{url}</Text>
      <Box marginTop={1} flexDirection="column">
        {shown.map((l, i) => (
          <Text key={i} dimColor>
            {`  ${l}`}
          </Text>
        ))}
        {hidden > 0 && <Text dimColor>{`  ${glyph.fold} ${hidden} more lines`}</Text>}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={accent.warn}>
          {kind === 'skill'
            ? 'A skill is instructions the agent follows. This text joins your system prompt.'
            : 'A plugin adds refusal rules. It is data, not code: nothing here is executed.'}
        </Text>
        <Text>
          <Text color={accent.ok} bold>
            y
          </Text>
          <Text dimColor>{` install ${glyph.sep} `}</Text>
          <Text color={accent.err} bold>
            n
          </Text>
          <Text dimColor> cancel</Text>
        </Text>
      </Box>
    </Box>
  );
}
