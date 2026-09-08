import { Box, Text } from 'ink';
import React from 'react';
import { SidePanel } from './Panels';
import { accent, glyph } from './theme';

export type HeaderFact = {
  label: string;
  value: string;
  /** Defaults to the quiet metadata colour; set for anything the user must not miss. */
  tone?: 'warn' | 'err' | 'ok' | 'info';
};

const TONE_COLOR: Record<NonNullable<HeaderFact['tone']>, string> = {
  warn: accent.warn,
  err: accent.err,
  ok: accent.ok,
  info: accent.info,
};

/**
 * The welcome dashboard, shown once before the first turn, in OpenCode's grammar.
 *
 * The session is introduced by a banner (what this conversation is), then the
 * environment is grouped into a labelled panel so the eye scans one label rather
 * than a wall of text. A final meta bar carries cwd and version, the two facts a
 * bug report needs. Facts that demand attention — a missing provider, a failed
 * plugin, `--yolo` — are lifted out of the quiet layer with colour, because a
 * warning rendered dim is a warning nobody reads.
 */
export function Header({
  version,
  provider,
  model,
  sessionId,
  cwd,
  title,
  facts,
}: {
  version: string;
  provider?: string;
  model?: string;
  sessionId: string;
  cwd: string;
  title?: string;
  facts: readonly HeaderFact[];
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <SidePanel label={title ?? 'new session'} tone={accent.user}>
        <Box>
          {model ? (
            <>
              <Text color={accent.ok}>{`${glyph.ok} `}</Text>
              <Text bold>
                {provider ? `${provider}/` : ''}
                {model}
              </Text>
              <Text dimColor>{`  ${glyph.sep}  session ${sessionId}`}</Text>
            </>
          ) : (
            <>
              <Text color={accent.warn}>{`${glyph.warn} `}</Text>
              <Text color={accent.warn}>no provider configured</Text>
              <Text dimColor>{`  ${glyph.sep}  run /provider to begin`}</Text>
            </>
          )}
        </Box>
      </SidePanel>

      {facts.length > 0 && (
        <SidePanel label="environment" tone={accent.ok}>
          {facts.map((f, i) => (
            <Box key={i}>
              <Text dimColor>{f.label.padEnd(14)}</Text>
              <Text color={f.tone ? TONE_COLOR[f.tone] : undefined} dimColor={f.tone === undefined}>
                {f.value}
              </Text>
            </Box>
          ))}
        </SidePanel>
      )}

      <Box paddingX={1}>
        <Text dimColor>{cwd}</Text>
        <Text dimColor>{`  ${glyph.sep}  `}</Text>
        <Text dimColor>{`shiro-neko ${version}`}</Text>
        <Text dimColor>{`  ${glyph.sep}  `}</Text>
        <Text color={accent.user}>/help for commands</Text>
      </Box>
    </Box>
  );
}
