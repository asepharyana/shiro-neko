import { expect, test } from 'bun:test';
import { VERSION, versionLine } from '../src/version';

test('the version is a valid semver, prerelease allowed', () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});

test('package.json agrees with the compiled constant', async () => {
  const pkg = (await Bun.file('package.json').json()) as { version?: string };
  expect(pkg.version).toBe(VERSION);
});

test('the version line identifies the build', () => {
  const line = versionLine();
  expect(line).toContain('shiro-neko');
  expect(line).toContain(VERSION);
  expect(line).toContain(Bun.version);
  expect(line).toContain(process.platform);
  expect(line).toContain(process.arch);
});

test('running from source is reported as source', () => {
  expect(versionLine()).toContain('source');
});

test('the release targets cover every platform we claim to ship', async () => {
  const { TARGETS } = await import('../scripts/release');
  const names = TARGETS.map((t) => t.name);
  expect(names).toEqual(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64']);
  expect(TARGETS.filter((t) => t.windows)).toHaveLength(1);
});

test('every release target is a real bun target triple', async () => {
  const { TARGETS } = await import('../scripts/release');
  for (const t of TARGETS) expect(t.target).toMatch(/^bun-(linux|darwin|windows)-(x64|arm64)$/);
});
