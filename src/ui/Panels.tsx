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

/** Status line under the transcript: model, agent, thinking, context, spend. */
export function StatusBar({
  model,
  agent,
  thinking,
  contextTokens,
  cost,
  toolCount,
}: {
  model: string;
  agent: string;
  thinking: string;
  contextTokens: number;
  cost: string;
  toolCount: number;
}) {
  return (
    <Box>
      <Text dimColor>{`${model}  `}</Text>
      <Text color="cyan">{agent}</Text>
      <Text dimColor>{`/${thinking}  ${toolCount} tools  ~${contextTokens} ctx  ${cost}`}</Text>
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
