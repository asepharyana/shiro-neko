import { join } from 'node:path';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';

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