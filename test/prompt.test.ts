import { expect, test } from 'bun:test';
import { renderTools, systemPrompt, TOOL_DOCS } from '../src/prompt';

const ALL = TOOL_DOCS.map((d) => d.name);

test('every documented tool has usable guidance', () => {
  for (const doc of TOOL_DOCS) {
    expect(doc.name).toBeTruthy();
    expect(doc.line.length).toBeGreaterThan(20);
  }
});

test('read guidance steers the model to batch reads for efficiency', () => {
  const readMany = TOOL_DOCS.find((d) => d.name === 'read_many_files');
  const readOne = TOOL_DOCS.find((d) => d.name === 'read_file');
  expect(readMany?.line).toContain('batch');
  expect(readMany?.line).toContain('read_file');
  expect(readOne?.line).toContain('read_many_files');
  // The "How to work" block also instructs batched reading.
  const prompt = systemPrompt({ cwd: '/repo', availableTools: ['read_file', 'read_many_files'] });
  expect(prompt).toContain('Read efficiently');
  expect(prompt).toContain('read_many_files');
});

test('only the offered tools are described', () => {
  const rendered = renderTools(['read_file', 'grep']);
  expect(rendered).toContain('read_file');
  expect(rendered).toContain('grep');
  expect(rendered).not.toContain('bash');
  expect(rendered).not.toContain('write_file');
});

test('new built-in tools are documented and a patch-only set is treated as editable', () => {
  expect(TOOL_DOCS.map((doc) => doc.name)).toEqual(expect.arrayContaining(['apply_patch', 'web_fetch']));

  const prompt = systemPrompt({ cwd: '/repo', availableTools: ['apply_patch'] });
  expect(prompt).toContain('apply_patch');
  expect(prompt).not.toContain('no tools that change anything');
});

test('mcp tools are grouped with their naming convention explained', () => {
  const rendered = renderTools(['read_file', 'mcp__fs__read', 'mcp__api__query']);
  expect(rendered).toContain('mcp__api__query, mcp__fs__read');
  expect(rendered).toContain('mcp__<server>__<tool>');
  expect(rendered).toContain('needs approval');
});

test('lazy mcp meta-tools prompt the workflow, and mcp__ and meta-tools do not double-list', () => {
  const rendered = renderTools(['read_file', 'mcp_list', 'mcp_inspect', 'mcp_call']);
  expect(rendered).toContain('mcp_list, mcp_inspect, mcp_call');
  expect(rendered).toContain('Never guess a server or tool name');
  expect(rendered).not.toContain('mcp__<server>__<tool>');
});

test('an unknown tool is listed rather than silently dropped', () => {
  expect(renderTools(['read_file', 'some_plugin_tool'])).toContain('some_plugin_tool');
});

test('the prompt states the workspace and platform', () => {
  const prompt = systemPrompt({ cwd: '/repo/thing' });
  expect(prompt).toContain('/repo/thing');
  expect(prompt).toContain(process.platform);
  expect(prompt).toContain('resolved inside the workspace');
});

test('a read-only tool set changes the workflow rules', () => {
  const readOnly = systemPrompt({ cwd: '/repo', availableTools: ['read_file', 'grep'] });
  expect(readOnly).toContain('no tools that change anything');
  expect(readOnly).toContain('cannot run commands');
  expect(readOnly).not.toContain('need the user to approve');
});

test('a full tool set explains approval and verification', () => {
  const full = systemPrompt({ cwd: '/repo', availableTools: ALL });
  expect(full).toContain('need the user to approve');
  expect(full).toContain('run_checks');
  expect(full).not.toContain('no tools that change anything');
});

test('the prompt says whether asking is possible', () => {
  expect(systemPrompt({ cwd: '/repo', availableTools: ['ask'], canAsk: true })).toContain('Ask rather than guess');
  expect(systemPrompt({ cwd: '/repo', availableTools: ['ask'], canAsk: false })).toContain(
    'No one can answer a question',
  );
});

test('canAsk without the tool still reports that nothing can answer', () => {
  const prompt = systemPrompt({ cwd: '/repo', availableTools: ['read_file'], canAsk: false });
  expect(prompt).toContain('No one can answer');
});

test('the reply guidance mentions rendered markdown', () => {
  const prompt = systemPrompt({ cwd: '/repo' });
  expect(prompt).toContain('Markdown is rendered');
  expect(prompt).toContain('fenced code blocks');
});

test('every optional section is appended when supplied', () => {
  const prompt = systemPrompt({
    cwd: '/repo',
    memory: '\nMEMORY-SECTION',
    skills: '\nSKILLS-SECTION',
    agent: '\nAGENT-SECTION',
    plugins: '\nPLUGIN-SECTION',
    notebook: '\nNOTEBOOK-SECTION',
  });
  for (const marker of [
    'MEMORY-SECTION',
    'SKILLS-SECTION',
    'AGENT-SECTION',
    'PLUGIN-SECTION',
    'NOTEBOOK-SECTION',
  ]) {
    expect(prompt).toContain(marker);
  }
});

test('omitting every section leaves no dangling markers', () => {
  const prompt = systemPrompt({ cwd: '/repo' });
  expect(prompt).not.toContain('undefined');
  expect(prompt.endsWith('\n')).toBe(true);
});

test('the prompt stays a reasonable size with everything on', () => {
  const prompt = systemPrompt({ cwd: '/repo', availableTools: ALL, canAsk: true });
  console.log('PROMPT_SIZE', prompt.length, 'BUDGET', 5100 + (TOOL_DOCS.length - 22) * 120);
  // Sent on every request, so a runaway prompt is a direct cost. The budget scales
  // with the documented-tool count: a new tool earns its own line, the rest must not.
  expect(prompt.length).toBeLessThan(5100 + (TOOL_DOCS.length - 22) * 120);
});
