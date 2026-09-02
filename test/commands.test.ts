import { expect, test } from 'bun:test';
import { COMMANDS, HELP, isMenuOpen, matchCommands, parseCommand } from '../src/commands';

test('bare text is a prompt', () => {
  expect(parseCommand('fix the auth bug')).toEqual({ type: 'prompt', text: 'fix the auth bug' });
});

test('blank input is a no-op', () => {
  expect(parseCommand('   ')).toEqual({ type: 'none' });
});

test('known commands map to their actions', () => {
  expect(parseCommand('/exit').type).toBe('exit');
  expect(parseCommand('/quit').type).toBe('exit');
  expect(parseCommand('/clear').type).toBe('clear');
  expect(parseCommand('/compact').type).toBe('compact');
  expect(parseCommand('/tools').type).toBe('tools');
  expect(parseCommand('/cost').type).toBe('cost');
  expect(parseCommand('/sessions').type).toBe('sessions');
  expect(parseCommand('/save').type).toBe('save');
  expect(parseCommand('/help').type).toBe('info');
  expect(parseCommand('/provider').type).toBe('provider');
  expect(parseCommand('/login').type).toBe('provider');
  expect(parseCommand('/models').type).toBe('models');
});

test('commands with arguments carry the argument', () => {
  expect(parseCommand('/model gpt-5-mini')).toEqual({ type: 'model', model: 'gpt-5-mini' });
  expect(parseCommand('/resume 01931f2a')).toEqual({ type: 'resume', id: '01931f2a' });
});

test('/model with no argument opens the picker instead of erroring', () => {
  expect(parseCommand('/model')).toEqual({ type: 'models' });
});

test('/resume with no argument returns usage', () => {
  expect(parseCommand('/resume')).toEqual({ type: 'info', text: 'usage: /resume <session-id>' });
});

test('unknown command is reported, not sent to the model', () => {
  expect(parseCommand('/frobnicate')).toEqual({ type: 'unknown', name: 'frobnicate' });
});

test('a slash inside a sentence still counts as a prompt', () => {
  expect(parseCommand('what does src/cli.tsx do?')).toEqual({ type: 'prompt', text: 'what does src/cli.tsx do?' });
});

test('the feature commands map to their actions', () => {
  expect(parseCommand('/skills').type).toBe('skills');
  expect(parseCommand('/plugins').type).toBe('plugins');
  expect(parseCommand('/memory').type).toBe('memory');
  expect(parseCommand('/todos').type).toBe('todos');
  expect(parseCommand('/notes').type).toBe('notes');
  expect(parseCommand('/context').type).toBe('context');
  expect(parseCommand('/init').type).toBe('init');
});

test('/agent takes an optional name, opening the picker without one', () => {
  expect(parseCommand('/agent deep')).toEqual({ type: 'agent', agent: 'deep' });
  expect(parseCommand('/agent')).toEqual({ type: 'agent' });
});

test('/think takes an optional level, opening the picker without one', () => {
  expect(parseCommand('/think max')).toEqual({ type: 'think', level: 'max' });
  expect(parseCommand('/think')).toEqual({ type: 'think' });
});

test('every menu entry parses to something other than unknown', () => {
  for (const c of COMMANDS) {
    expect(parseCommand(`/${c.name}`).type).not.toBe('unknown');
    for (const alias of c.aliases ?? []) expect(parseCommand(`/${alias}`).type).not.toBe('unknown');
  }
});

test('/help lists every command so the menu and help cannot drift apart', () => {
  for (const c of COMMANDS) expect(HELP).toContain(`/${c.name}`);
});

test('a lone slash lists the whole menu', () => {
  expect(matchCommands('/').map((c) => c.name)).toEqual(COMMANDS.map((c) => c.name));
});

test('a prefix narrows the menu', () => {
  expect(matchCommands('/co').map((c) => c.name)).toEqual(['context', 'compact', 'cost']);
  expect(matchCommands('/se').map((c) => c.name)).toEqual(['sessions']);
  expect(matchCommands('/ag').map((c) => c.name)).toEqual(['agent']);
  expect(matchCommands('/th').map((c) => c.name)).toEqual(['think']);
});

test('an exact name sorts first so enter cannot run its longer sibling', () => {
  expect(matchCommands('/model').map((c) => c.name)).toEqual(['model', 'models']);
  expect(matchCommands('/mo').map((c) => c.name)).toEqual(['models', 'model']);
});

test('matching is case-insensitive', () => {
  expect(matchCommands('/CO').map((c) => c.name)).toEqual(['context', 'compact', 'cost']);
});

test('no match yields an empty menu, so plain text is unobstructed', () => {
  expect(matchCommands('/zzz')).toEqual([]);
  expect(matchCommands('hello')).toEqual([]);
});

test('the menu closes once an argument is being typed', () => {
  expect(matchCommands('/resume 019')).toEqual([]);
  expect(isMenuOpen('/resume 019')).toBe(false);
  expect(isMenuOpen('/resume')).toBe(true);
  expect(isMenuOpen('hello')).toBe(false);
});

test('aliases are hidden from the menu but still parse', () => {
  expect(matchCommands('/lo')).toEqual([]);
  expect(parseCommand('/login').type).toBe('provider');
});

test('/registry with no verb lists everything', () => {
  expect(parseCommand('/registry')).toEqual({ type: 'registry', action: 'list' });
  expect(parseCommand('/registry list')).toEqual({ type: 'registry', action: 'list' });
});

test('/registry installed asks for what is already here', () => {
  expect(parseCommand('/registry installed')).toEqual({ type: 'registry', action: 'installed' });
});

test('/registry search carries the query', () => {
  expect(parseCommand('/registry search migration')).toEqual({
    type: 'registry',
    action: 'search',
    arg: 'migration',
  });
});

test('/registry add and remove carry the name, and their aliases work', () => {
  expect(parseCommand('/registry add migration')).toEqual({ type: 'registry', action: 'add', arg: 'migration' });
  expect(parseCommand('/registry install migration')).toEqual({ type: 'registry', action: 'add', arg: 'migration' });
  expect(parseCommand('/registry remove migration')).toEqual({ type: 'registry', action: 'remove', arg: 'migration' });
  expect(parseCommand('/registry uninstall migration')).toEqual({
    type: 'registry',
    action: 'remove',
    arg: 'migration',
  });
});

test('a kind-qualified name survives parsing, since a name can be both', () => {
  expect(parseCommand('/registry add plugin:review')).toEqual({
    type: 'registry',
    action: 'add',
    arg: 'plugin:review',
  });
});

test('/registry add with no name returns usage rather than fetching anything', () => {
  expect(parseCommand('/registry add')).toEqual({ type: 'info', text: 'usage: /registry add <name>' });
  expect(parseCommand('/registry remove')).toEqual({ type: 'info', text: 'usage: /registry remove <name>' });
  expect(parseCommand('/registry search')).toEqual({ type: 'info', text: 'usage: /registry search <query>' });
});

test('a bare word after /registry is treated as a search', () => {
  expect(parseCommand('/registry migration')).toEqual({ type: 'registry', action: 'search', arg: 'migration' });
});
