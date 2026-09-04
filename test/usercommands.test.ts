import { expect, test } from 'bun:test';
import { expandCommand, parseUserCommands } from '../src/usercommands';

test('parses name, summary, and body from markdown headings', () => {
  const commands = parseUserCommands(`# scratch

## review
> summarise this change

Summarise the diff. Be concise.

## scaffold
> make a new module

Create a module called $1.
`);
  expect(commands).toHaveLength(2);
  expect(commands[0]!.name).toBe('review');
  expect(commands[0]!.summary).toBe('summarise this change');
  expect(commands[0]!.body).toContain('Summarise the diff. Be concise.');
  expect(commands[1]!.name).toBe('scaffold');
});

test('lowercases command names so /Review matches review', () => {
  const commands = parseUserCommands('## Template\nbody');
  expect(commands[0]!.name).toBe('template');
});

test('substitutes $1 and $ARGUMENTS', async () => {
  const [cmd] = parseUserCommands('## x\nUse $1 heavily and all of $ARGUMENTS.');
  const out = await expandCommand(cmd!, 'foo bar baz', process.cwd());
  expect(out).toBe('Use foo heavily and all of foo bar baz.');
});

test('reads @path files relative to the workspace root', async () => {
  const [cmd] = parseUserCommands('## r\nRead here:\n@package.json\nThen continue.');
  const out = await expandCommand(cmd!, '', process.cwd());
  const content = (await Bun.file('package.json').text()).trimEnd();
  expect(out).toContain('Read here:\n'.concat(content).concat('\nThen continue.'));
});

test('expands !shell output inline', async () => {
  const [cmd] = parseUserCommands('## s\nBranch is !`git branch --show-current`.');
  const out = await expandCommand(cmd!, '', process.cwd());
  expect(out).toMatch(/Branch is (main|[a-z-]+)\./);
});
