import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import React, { useState } from 'react';
import type { AskRequest } from '../ask';
import { InlineMarkdown } from './Markdown';
import { PromptInput } from './PromptInput';

export type AskPending = { req: AskRequest; resolve: (answers: string[] | undefined) => void };

/** Bridges the ask tool's promise into React state, the same shape as the approval bridge. */
export type AskBridge = {
  bind: (fn: (p: AskPending | undefined) => void) => void;
  ask: (req: AskRequest) => Promise<string[] | undefined>;
};

export function createAskBridge(): AskBridge {
  let setter: ((p: AskPending | undefined) => void) | undefined;
  return {
    bind(fn) {
      setter = fn;
    },
    ask(req) {
      return new Promise((resolve) => {
        // No UI mounted means no one can answer; resolving undefined lets the tool
        // tell the model to decide for itself rather than hanging forever.
        if (!setter) return resolve(undefined);
        setter({
          req,
          resolve: (answers) => {
            setter?.(undefined);
            resolve(answers);
          },
        });
      });
    },
  };
}

const TYPE_YOUR_OWN = '__own__';

/**
 * The question popup.
 *
 * Options become a picker; no options, or "type your own", falls back to free text.
 * Escape resolves undefined rather than leaving the tool waiting.
 */
export function AskPanel({ pending }: { pending: AskPending }) {
  const { question, options, multiple } = pending.req;
  const [chosen, setChosen] = useState<string[]>([]);
  const [typing, setTyping] = useState(!options || options.length === 0);
  const [draft, setDraft] = useState('');

  useInput(
    (_input, key) => {
      if (key.escape) pending.resolve(undefined);
    },
    { isActive: !typing },
  );

  const items = [
    ...(options ?? []).map((o) => ({
      key: o.label,
      label: chosen.includes(o.label) ? `[x] ${o.label}` : multiple ? `[ ] ${o.label}` : o.label,
      value: o.label,
    })),
    ...(multiple && chosen.length > 0 ? [{ key: '__done__', label: `-- submit ${chosen.length} --`, value: '__done__' }] : []),
    { key: TYPE_YOUR_OWN, label: 'type your own answer...', value: TYPE_YOUR_OWN },
  ];

  const detailOf = (label: string) => (options ?? []).find((o) => o.label === label)?.detail;

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>
        shiro is asking
      </Text>
      <Box marginBottom={1}>
        <InlineMarkdown text={question} />
      </Box>

      {typing ? (
        <Box>
          <Text color="yellow">{'> '}</Text>
          <PromptInput
            value={draft}
            onChange={setDraft}
            onSubmit={(v) => pending.resolve(v.trim() ? [v.trim()] : undefined)}
            placeholder="type your answer, enter to send"
          />
        </Box>
      ) : (
        <Box flexDirection="column">
          <SelectInput
            items={items}
            limit={10}
            onSelect={(item) => {
              if (item.value === TYPE_YOUR_OWN) return setTyping(true);
              if (item.value === '__done__') return pending.resolve(chosen);
              if (!multiple) return pending.resolve([item.value]);
              setChosen((c) => (c.includes(item.value) ? c.filter((x) => x !== item.value) : [...c, item.value]));
            }}
            onHighlight={(item) => {
              const detail = detailOf(item.value);
              if (detail) setDraft(detail);
              else setDraft('');
            }}
          />
          {draft.length > 0 && <Text dimColor>{draft}</Text>}
          <Text dimColor>
            {multiple ? 'space/enter toggles, pick submit when done' : 'enter to choose'} | esc to skip
          </Text>
        </Box>
      )}
    </Box>
  );
}
