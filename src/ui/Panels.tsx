import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import React from 'react';
import { TODO_MARK, type Todo } from '../notebook';
import type { SubagentKind } from '../subagent';
import { InlineMarkdown } from './Markdown';

const STATUS_COLOR: Record<Todo['status'], string | undefined> = {
  pending: undefined,
  in_progress: 'cyan',
  done: 'green',
  blocked: 'red',
};

/** Task list with a progress bar, shown above the input while a list exists. */
export function TodoPanel({ todos, width = 40 }: { todos: Todo[]; width?: number }) {
  const done = todos.filter((t) => t.status === 'done').length;
  const blocked = todos.filter((t) => t.status === 'blocked').length;
  const filled = todos.length === 0 ? 0 : Math.round((done / todos.length) * width);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1}>
      <Box>
        <Text bold>tasks </Text>
        <Text color="green">{'#'.repeat(filled)}</Text>
        <Text dimColor>{'.'.repeat(Math.max(0, width - filled))}</Text>
        <Text dimColor>{` ${done}/${todos.length}`}</Text>
        {blocked > 0 && <Text color="red">{`  ${blocked} blocked`}</Text>}
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

export type SubagentView = {
  id: string;
  kind: SubagentKind;
  description: string;
  steps: { tool: string; summary: string }[];
  status: 'running' | 'done' | 'failed';
  error?: string;
};

const KIND_LABEL: Record<SubagentKind, string> = { explore: 'explore', review: 'review' };

/**
 * Live view of delegated work.
 *
 * A subagent can run for a minute over many files; without this the parent's spinner
 * is the only feedback and the user cannot tell progress from a hang.
 */
export function SubagentPanel({ agents }: { agents: SubagentView[] }) {
  if (agents.length === 0) return null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginBottom={1}>
      {agents.map((a) => (
        <Box key={a.id} flexDirection="column">
          <Box>
            {a.status === 'running' ? (
              <Text color="magenta">
                <Spinner type="dots" />
              </Text>
            ) : (
              <Text color={a.status === 'done' ? 'green' : 'red'}>{a.status === 'done' ? '*' : 'x'}</Text>
            )}
            <Text bold>{` ${KIND_LABEL[a.kind]}`}</Text>
            <Text>{`: ${a.description}`}</Text>
            <Text dimColor>{`  ${a.steps.length} step${a.steps.length === 1 ? '' : 's'}`}</Text>
          </Box>
          {a.steps.slice(-3).map((s, i) => (
            <Text key={i} dimColor>
              {`    ${s.tool}(${s.summary.slice(0, 60)})`}
            </Text>
          ))}
          {a.error && <Text color="red">{`    ${a.error}`}</Text>}
        </Box>
      ))}
    </Box>
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
            {`  | ${l}`}
          </Text>
        ))}
    </Box>
  );
}

/**
 * The tool call in flight, from tool-start until its result arrives.
 *
 * A read of a large file or a two-minute test run is otherwise indistinguishable
 * from a hang, and the name arrives before the arguments finish streaming, so the
 * summary is filled in a moment later.
 */
export function ActiveTool({ name, summary }: { name: string; summary?: string }) {
  return (
    <Box>
      <Text color="magenta">
        <Spinner type="dots" />
      </Text>
      <Text>{` ${name}`}</Text>
      {summary ? <Text dimColor>{` ${summary}`}</Text> : null}
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
    return <Text dimColor>{`thinking... ~${tokens} tokens  ctrl-r to expand`}</Text>;
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>{`thinking  ~${tokens} tokens  ctrl-r to collapse`}</Text>
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
      <Text color="cyan">{`queued: ${prompts.length}`}</Text>
      {prompts.map((p, i) => (
        <Text key={i} dimColor>
          {`  ${i + 1}. ${p.length > 70 ? `${p.slice(0, 70)}...` : p}`}
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
        <Text dimColor>indexing files...</Text>
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
        <Text key={p} color={i === index ? 'cyan' : undefined} dimColor={i !== index}>
          {i === index ? '> ' : '  '}
          {p}
        </Text>
      ))}
      <Text dimColor>up/down move | tab or enter insert | esc dismiss</Text>
    </Box>
  );
}

/** Status line under the transcript: model, agent, thinking, context, spend. */
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
  // before a turn silently loses its history, not after.
  const contextColor = pct === undefined ? undefined : pct >= 90 ? 'red' : pct >= 66 ? 'yellow' : undefined;

  return (
    <Box>
      <Text dimColor>{`${model}  `}</Text>
      <Text color="cyan">{agent}</Text>
      <Text dimColor>{`/${thinking}  ${toolCount} tools  `}</Text>
      <Text color={contextColor} dimColor={contextColor === undefined}>
        {pct === undefined ? `~${contextTokens} ctx` : `${pct}% ctx`}
      </Text>
      <Text dimColor>{`  ${cost}`}</Text>
    </Box>
  );
}

export type PanelLine = { label: string; value: string };

/** Bordered popup for a command's output, e.g. /skills or /cost. */
export function InfoPanel({ title, hint, lines }: { title: string; hint?: string; lines: PanelLine[] | string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
      <Text color="cyan" bold>
        {title}
      </Text>
      {hint && <Text dimColor>{hint}</Text>}
      {typeof lines === 'string' ? (
        <InlineMarkdown text={lines} />
      ) : (
        lines.map((l, i) => (
          <Box key={i}>
            <Text color="gray">{l.label.padEnd(14)}</Text>
            <Text>{l.value}</Text>
          </Box>
        ))
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

const KIND_COLOR: Record<RegistryRow['kind'], string> = { skill: 'green', plugin: 'magenta' };

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
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
      <Text color="cyan" bold>
        {title}
      </Text>
      {hint && <Text dimColor>{hint}</Text>}
      {rows.map((r) => (
        <Box key={`${r.kind}:${r.name}`}>
          <Text color={KIND_COLOR[r.kind]}>{r.kind === 'skill' ? 'S' : 'P'} </Text>
          <Text bold>{r.name.padEnd(width)}</Text>
          <Text dimColor>{r.description.length > 58 ? `${r.description.slice(0, 58)}...` : r.description}</Text>
          {r.installed && <Text color="green">{'  installed'}</Text>}
        </Box>
      ))}
      <Text dimColor>{'S skill  P plugin  |  /registry add <name>'}</Text>
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
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>
        {`install ${kind} "${name}"?`}
      </Text>
      <Text dimColor>{url}</Text>
      <Box marginTop={1} flexDirection="column">
        {shown.map((l, i) => (
          <Text key={i} dimColor>
            {`  ${l}`}
          </Text>
        ))}
        {hidden > 0 && <Text dimColor>{`  ... ${hidden} more lines`}</Text>}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="yellow">
          {kind === 'skill'
            ? 'A skill is instructions the agent follows. This text joins your system prompt.'
            : 'A plugin adds refusal rules. It is data, not code: nothing here is executed.'}
        </Text>
        <Text>
          <Text color="green">y</Text> install | <Text color="red">n</Text> cancel
        </Text>
      </Box>
    </Box>
  );
}
