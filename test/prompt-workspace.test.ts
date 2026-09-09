import { expect, test } from 'bun:test';
import { systemPrompt } from '../src/prompt';

test('workspaceFiles are injected gitignore-style when provided', () => {
  const prompt = systemPrompt({ cwd: '/repo', workspaceFiles: ['src/app.ts', 'README.md'] });
  expect(prompt).toContain('Workspace files (2, gitignore-respected');
  expect(prompt).toContain('src/app.ts');
  expect(prompt).toContain('README.md');
});

test('workspaceFiles omitted when empty', () => {
  const prompt = systemPrompt({ cwd: '/repo', workspaceFiles: [] });
  expect(prompt).not.toContain('Workspace files');
});

test('workspaceFiles undefined leaves prompt unchanged', () => {
  const prompt = systemPrompt({ cwd: '/repo' });
  expect(prompt).not.toContain('Workspace files');
});
