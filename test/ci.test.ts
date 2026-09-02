import { expect, test } from 'bun:test';
import { VERSION } from '../src/version';

const read = (path: string) => Bun.file(path).text();

test('both workflows exist and are non-trivial', async () => {
  for (const path of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    const text = await read(path);
    expect(text.length).toBeGreaterThan(200);
    // A tab anywhere in YAML is a parse error.
    expect(text).not.toContain('\t');
  }
});

test('ci runs the suite on all three platforms', async () => {
  const ci = await read('.github/workflows/ci.yml');
  for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) expect(ci).toContain(os);
  expect(ci).toContain('bun run typecheck');
  expect(ci).toContain('bun test');
  expect(ci).toContain('bun run build');
});

test('release is triggered by a v tag and can be dry-run by hand', async () => {
  const release = await read('.github/workflows/release.yml');
  expect(release).toContain("tags: ['v*']");
  expect(release).toContain('workflow_dispatch');
});

test('release verifies before it builds, and builds before it publishes', async () => {
  const release = await read('.github/workflows/release.yml');
  expect(release).toContain('needs: verify');
  expect(release).toContain('needs: build');
  expect(release.indexOf('bun test')).toBeLessThan(release.indexOf('bun run release'));
});

test('publishing is gated on a tag, so a manual run cannot release by accident', async () => {
  const release = await read('.github/workflows/release.yml');
  expect(release).toContain("if: startsWith(github.ref, 'refs/tags/v')");
});

test('a prerelease tag is marked as a prerelease', async () => {
  const release = await read('.github/workflows/release.yml');
  expect(release).toContain('--prerelease');
  // The current version is a prerelease, so the marker has to be reachable.
  expect(VERSION).toContain('-');
});

test('the release pins the bun version rather than tracking latest', async () => {
  for (const path of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    expect(await read(path)).toContain(`bun-version: ${Bun.version}`);
  }
});

test('the workflow only needs the default token and write access to contents', async () => {
  const release = await read('.github/workflows/release.yml');
  expect(release).toContain('contents: write');
  expect(release).toContain('GH_TOKEN: ${{ github.token }}');
});

test('the install scripts exist for both platform families', async () => {
  const sh = await read('scripts/install.sh');
  const ps1 = await read('scripts/install.ps1');

  expect(sh).toContain('#!/usr/bin/env sh');
  expect(sh).toContain('set -eu');
  for (const asset of ['linux', 'darwin', 'x64', 'arm64']) expect(sh).toContain(asset);
  expect(ps1).toContain('shiro-windows-x64.exe');
});

test('both install scripts verify the checksum', async () => {
  expect(await read('scripts/install.sh')).toContain('SHA256SUMS');
  expect(await read('scripts/install.ps1')).toContain('SHA256SUMS');
  expect(await read('scripts/install.sh')).toContain('checksum mismatch');
  expect(await read('scripts/install.ps1')).toContain('checksum mismatch');
});

test('both install scripts allow pinning a version and a target directory', async () => {
  for (const path of ['scripts/install.sh', 'scripts/install.ps1']) {
    const text = await read(path);
    expect(text).toContain('SHIRO_VERSION');
    expect(text).toContain('SHIRO_INSTALL_DIR');
  }
});

test('the asset names the installers fetch match what release.ts produces', async () => {
  const { TARGETS } = await import('../scripts/release');
  const sh = await read('scripts/install.sh');
  const ps1 = await read('scripts/install.ps1');

  for (const t of TARGETS) {
    const asset = t.windows ? `shiro-${t.name}.exe` : `shiro-${t.name}`;
    const [os, arch] = t.name.split('-');
    if (t.windows) {
      expect(ps1, asset).toContain(asset);
    } else {
      // The shell script composes the name, so both halves must appear.
      expect(sh, `${asset} os`).toContain(os!);
      expect(sh, `${asset} arch`).toContain(arch!);
    }
  }
});
