#!/usr/bin/env bun
/**
 * Writes `release_notes.md` for a release tag, extracting the tag's prose from
 * CHANGELOG.md and appending the artifact inventory. Used by .github/workflows/
 * release.yml so the release page reads like a hand-written one instead of the raw
 * PR list.
 *
 * Reads the tag from $RELEASE_TAG (GITHUB_REF_NAME, e.g. `v1.2.3`) and fails loudly
 * when CHANGELOG.md has no matching `## [<version>]` section, because a release with
 * an empty body is worse than one that refused to publish.
 */
const tag = process.env['RELEASE_TAG'] ?? 'v0.0.0-local';
const version = tag.replace(/^v/, '');

const changelog = await Bun.file('CHANGELOG.md').text();
const start = changelog.indexOf(`## [${version}]`);
if (start === -1) {
  console.error(`CHANGELOG.md has no "## [${version}]" heading for ${tag}`);
  process.exit(1);
}

// The section runs from its heading to the next `## [` heading, or to the file end.
// Drop the heading itself: the release title already carries the version, so keeping
// `## [1.0.0]` under `## What's in v1.0.0` would read twice.
let body = changelog.slice(start);
const next = body.indexOf('\n## [', 1);
if (next !== -1) body = body.slice(0, next);
body = body.replace(/^## \[.*\]\n+/, '').trim();

// ESM, so top-level await is fine; this file is only ever run as the entry script.
await Bun.write(
  'release_notes.md',
  [
    `## What's in ${tag}`,
    '',
    body,
    '',
    '### Artifacts',
    '- `shiro-linux-x64`, `shiro-linux-arm64` - Linux',
    '- `shiro-darwin-x64`, `shiro-darwin-arm64` - macOS',
    '- `shiro-windows-x64.exe` - Windows',
    '- `SHA256SUMS` - verify any of the above',
    '',
    'Install with `scripts/install.sh` (macOS/Linux) or `scripts/install.ps1` (Windows);',
    'both verify the download against `SHA256SUMS`.',
  ].join('\n'),
);

console.log(`composed release_notes.md from the ${version} changelog section (${body.split('\n').length} prose lines)`);
process.exit(0);