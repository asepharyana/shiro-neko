import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { scaffoldMissingAuto, projectTracksAt } from '../src/scaffold';
import { usageOf } from './helpers';

const usage = usageOf(5, 3);

function textParts(body: string): LanguageModelV4StreamPart[] {
  return [
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: body },
    { type: 'text-end', id: '0' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
  ];
}

function stream(body: string) {
  const parts = textParts(body);
  return { stream: simulateReadableStream({ chunks: parts, chunkDelayInMs: null, initialDelayInMs: null }) };
}

function makeRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'shiro-scaffold-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, cleanup };
}

const ALL_FOUR = `===FILE TODO.md===
# TODO

## Now
- first

## Next
- second

===FILE ROADMAP.md===
# Roadmap

## Next
- plan

===FILE docs/README.md===
# Docs

Developer docs.

===FILE AGENTS.md===
# AGENTS

This project is a test.
`;

test('projectTracksAt is false for an empty repo and true when a tracker exists', async () => {
  const { dir, cleanup } = makeRepo();
  try {
    expect(projectTracksAt(dir)).toBe(false);
    await Bun.write(join(dir, 'TODO.md'), '# Todo\n');
    expect(projectTracksAt(dir)).toBe(true);
  } finally {
    cleanup();
  }
});

test('scaffoldMissingAuto writes all four files when the repo has none', async () => {
  const { dir, cleanup } = makeRepo();
  try {
    const model = new MockLanguageModelV4({ doStream: async () => stream(ALL_FOUR) });
    const written = await scaffoldMissingAuto(dir, model);
    // Expect 4 files written.
    expect(written.length).toBe(4);
    expect(existsSync(join(dir, 'TODO.md'))).toBe(true);
    expect(existsSync(join(dir, 'ROADMAP.md'))).toBe(true);
    expect(existsSync(join(dir, 'docs', 'README.md'))).toBe(true);
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true);
    // Content came from the model, not the empty template.
    expect(readFileSync(join(dir, 'TODO.md'), 'utf8')).toContain('- first');
  } finally {
    cleanup();
  }
});

test('scaffoldMissingAuto bails when a repo already tracks progress', async () => {
  const { dir, cleanup } = makeRepo();
  try {
    await Bun.write(join(dir, 'TODO.md'), '# Todo\n- [ ] existing\n');
    const model = new MockLanguageModelV4({ doStream: async () => stream('') });
    const written = await scaffoldMissingAuto(dir, model);
    expect(written).toEqual([]);
    expect(existsSync(join(dir, 'ROADMAP.md'))).toBe(false);
    expect(readFileSync(join(dir, 'TODO.md'), 'utf8')).toBe('# Todo\n- [ ] existing\n');
  } finally {
    cleanup();
  }
});

test('scaffoldMissingAuto degrades to empty templates when the model fails', async () => {
  const { dir, cleanup } = makeRepo();
  try {
    const model = new MockLanguageModelV4({ doStream: async () => { throw new Error('model down'); } });
    const written = await scaffoldMissingAuto(dir, model);
    // The fallback writes the empty-tracker templates so the session never dies.
    expect(written.length).toBeGreaterThanOrEqual(3);
    expect(existsSync(join(dir, 'TODO.md'))).toBe(true);
    expect(existsSync(join(dir, 'ROADMAP.md'))).toBe(true);
  } finally {
    cleanup();
  }
});

test('scaffoldMissingAuto bails entirely when any tracking file exists', async () => {
  const { dir, cleanup } = makeRepo();
  try {
    await Bun.write(join(dir, 'TODO.md'), 'precious');
    const model = new MockLanguageModelV4({
      doStream: async () =>
        stream('===FILE TODO.md===\n# TODO\noverwrite me\n===FILE ROADMAP.md===\n# Roadmap\n'),
    });
    const written = await scaffoldMissingAuto(dir, model);
    // A repo with any tracker is left alone — nothing new is written.
    expect(written).toEqual([]);
    expect(readFileSync(join(dir, 'TODO.md'), 'utf8')).toBe('precious');
    expect(existsSync(join(dir, 'ROADMAP.md'))).toBe(false);
  } finally {
    cleanup();
  }
});