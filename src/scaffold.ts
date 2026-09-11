import { join, dirname } from 'node:path';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { streamText } from 'ai';
import type { LanguageModel } from 'ai';

/** True when the repo holds the tracking files the workflow expects. */

/**
 * Scaffolds the project-workflow files when a repo has none.
 *
 * `/init` already writes AGENTS.md through the model. This writes the three
 * files the project-driven workflow (docs/workflow.md) expects when they are
 * missing, directly — no model round trip needed for empty templates.
 *
 * Never overwrites an existing file: a repo that already tracks progress
 * keeps what it has.
 */
export function scaffoldWorkflowFiles(cwd = process.cwd()): string[] {
  const written: string[] = [];

  const todo = join(cwd, 'TODO.md');
  if (!existsSync(todo)) {
    writeFileSync(
      todo,
      [
        '# TODO',
        '',
        'Next up. One item, one outcome, verifiable when done.',
        '',
        'Longer-term direction lives in [ROADMAP.md](ROADMAP.md).',
        '',
        '---',
        '',
        '## Now',
        '',
        '_Empty._',
        '',
        '---',
        '',
        '## Next',
        '',
        '_Empty._',
        '',
        '---',
        '',
        '## Maintenance',
        '',
        '_Empty._',
        '',
      ].join('\n'),
    );
    written.push('TODO.md');
  }

  const roadmap = join(cwd, 'ROADMAP.md');
  if (!existsSync(roadmap)) {
    writeFileSync(
      roadmap,
      [
        '# Roadmap',
        '',
        'What is built, what is next, and what has been deliberately declined.',
        '',
        '---',
        '',
        '## Next',
        '',
        '_Empty._',
        '',
      ].join('\n'),
    );
    written.push('ROADMAP.md');
  }

  const docsDir = join(cwd, 'docs');
  if (!existsSync(docsDir)) {
    try {
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(join(docsDir, 'README.md'), '# Docs\n\nDeveloper documentation for this project.\n');
      written.push('docs/');
    } catch {
      // a read-only workspace keeps what it has; a missing docs dir is not fatal
    }
  }

  return written;
}

/**
 * The set of workflow files the agent treats as "the project tracks itself".
 * Auto-scaffolding only runs when none of these exist — a repo that already
 * tracks progress keeps what it has.
 */
const TRACKING_NAMES = ['TODO.md', 'ROADMAP.md', 'AGENTS.md'] as const;

/** True when any tracking/instruction file exists at the git root. */
export function projectTracksAt(root: string, docsDir = 'docs'): boolean {
  for (const name of TRACKING_NAMES) {
    if (existsSync(join(root, name))) return true;
  }
  return existsSync(join(root, docsDir));
}

/**
 * Writes the workflow files a project-driven session expects when the repo
 * has none — before the first turn, so the system prompt's workflow policy and
 * the very first nudge see them. Uses the model to write project-specific
 * content (TODO.md, ROADMAP.md, docs/, AGENTS.md). Never overwrites.
 *
 * Returns the relative paths written. On model failure it degrades to the
 * empty-template scaffold so the *session* never fails — a missing model
 * should not break a turn.
 */
export async function scaffoldMissingAuto(
  root: string,
  model: LanguageModel,
  opts: { docsDir?: string; maxRetries?: number } = {},
): Promise<string[]> {
  const docsDir = opts.docsDir ?? 'docs';
  const todo = join(root, 'TODO.md');
  const roadmap = join(root, 'ROADMAP.md');
  const docs = join(root, docsDir);
  const agents = join(root, 'AGENTS.md');

  const hasTodo = existsSync(todo);
  const hasRoadmap = existsSync(roadmap);
  const hasDocs = existsSync(docs);
  const hasAgents = existsSync(agents);
  // A repo that already tracks anything is left alone.
  if (hasTodo || hasRoadmap || hasDocs || hasAgents) return [];

  const missing = {
    todo: !hasTodo,
    roadmap: !hasRoadmap,
    docs: !hasDocs,
    agents: !hasAgents,
  };

  // One model call for the whole set keeps it cheap; the prompt asks for real
  // content derived from the repo (the /init prompt does the same for AGENTS.md).
  // Uses a stream so it works with any model (mocks included) — a text-only
  // generateText would need doGenerate, which not every model implements.
  let content = '';
  try {
    const missingList = [
      missing.todo ? 'TODO.md — a task list: Now / Next / Maintenance sections, one item per line' : '',
      missing.roadmap ? 'ROADMAP.md — where the project is heading: Next section, what is built and what is deliberately declined' : '',
      missing.docs ? 'docs/ with a README.md — developer documentation' : '',
      missing.agents ? 'AGENTS.md — orientation for a coding agent joining cold: what the project is, install/build/test/typecheck commands, layout, conventions, surprising things' : '',
    ].filter(Boolean).join('; ');

    const { textStream: ts } = await streamText({
      model,
      system:
        'You are bootstrapping project workflow files for a codebase that has none. ' +
        'Write only the files, with real content derived from the repo. Keep each file concise and honest: ' +
        'TODO.md (Now/Next/Maintenance), ROADMAP.md (Next), docs/README.md, AGENTS.md. ' +
        'Do not invent commands you cannot verify. Output must be plain text with no markdown fences — ' +
        'the exact file contents for each file, separated by a line that reads exactly: ===FILE <path>===',
      prompt: `Look at this repo and write the missing workflow files. Missing: ${missingList}.`,
      maxRetries: opts.maxRetries ?? 3,
    });
    for await (const chunk of ts) content += chunk;
  } catch {
    // fall through to the empty-template scaffold below
  }

  if (content) {
    const written: string[] = [];
    // Split on the ===FILE <path>=== marker; each block is one file.
    const blocks = content.split(/^===FILE\s+(.+?)\s*===$/m);
    for (let i = 1; i + 1 < blocks.length; i += 2) {
      const rel = blocks[i]!.trim();
      const body = blocks[i + 1]!.trim();
      if (!(rel.startsWith('TODO.md') || rel.startsWith('ROADMAP.md') || rel.startsWith('docs/') || rel === 'AGENTS.md')) continue;
      const abs = join(root, rel);
      if (existsSync(abs)) continue;
      try {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, body.endsWith('\n') ? body : body + '\n');
        written.push(rel);
      } catch {
        // a read-only workspace keeps what it has
      }
    }
    // If the model produced at least one real file, that's the win; fill any
    // still-missing standard files with the empty templates.
    if (written.length > 0) {
      const templated = scaffoldWorkflowFiles(root);
      const union = [...written];
      for (const t of templated) {
        if (!union.includes(t)) union.push(t);
      }
      return union;
    }
  }

  // Model failed or wrote nothing: plain empty templates, never fail the turn.
  return scaffoldWorkflowFiles(root);
}