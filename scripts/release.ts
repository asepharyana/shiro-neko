import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '../src/version';

export type Target = {
  /** Bun cross-compilation target. */
  target: string;
  /** Suffix in the artifact name, matching what the installers look for. */
  name: string;
  windows?: boolean;
};

export const TARGETS: Target[] = [
  { target: 'bun-linux-x64', name: 'linux-x64' },
  { target: 'bun-linux-arm64', name: 'linux-arm64' },
  { target: 'bun-darwin-x64', name: 'darwin-x64' },
  { target: 'bun-darwin-arm64', name: 'darwin-arm64' },
  { target: 'bun-windows-x64', name: 'windows-x64', windows: true },
];

const OUT = 'dist/release';

/**
 * Build arguments for one target.
 *
 * Executable metadata can only be stamped by a Windows host: bun rejects
 * `--windows-title` when cross-compiling, and CI releases every target from one
 * Ubuntu runner. The published binary goes without it rather than the release
 * failing on the last of five builds.
 */
export function buildArgs(t: Target, outfile: string, host = process.platform): string[] {
  const args = ['build', '--compile', '--minify', `--target=${t.target}`, 'src/cli.tsx', '--outfile', outfile];
  if (t.windows && host === 'win32') {
    args.push(
      '--windows-title=shiro-neko',
      '--windows-description=Agentic coding CLI',
      `--windows-version=${VERSION.split('-')[0]}.0`,
    );
  }
  return args;
}

/**
 * Builds one executable per platform.
 *
 * Bun cross-compiles from any host, so a single runner produces every artifact and
 * no build matrix is needed. The version is compiled into the binary from
 * src/version.ts; a release tag must agree with it or the build stops, because a
 * binary reporting the wrong version is worse than a failed release.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = args.filter((a) => !a.startsWith('-'));
  const wanted = only.length > 0 ? TARGETS.filter((t) => only.includes(t.name)) : TARGETS;
  if (wanted.length === 0) {
    console.error(`no matching target. Available: ${TARGETS.map((t) => t.name).join(', ')}`);
    process.exit(1);
  }

  const pkg = (await Bun.file('package.json').json()) as { version?: string };
  if (pkg.version !== VERSION) {
    console.error(`version mismatch: package.json is ${pkg.version}, src/version.ts is ${VERSION}`);
    process.exit(1);
  }

  const tag = (process.env['GITHUB_REF_NAME'] ?? '').replace(/^v/, '');
  if (tag && tag !== VERSION) {
    console.error(`tag v${tag} does not match src/version.ts (${VERSION}). Bump the version or retag.`);
    process.exit(1);
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const built: { file: string; bytes: number }[] = [];

  for (const t of wanted) {
    const base = `shiro-${t.name}`;
    const outfile = join(OUT, base);

    const proc = Bun.spawn(['bun', ...buildArgs(t, outfile)], { stdout: 'inherit', stderr: 'inherit' });
    const code = await proc.exited;
    if (code !== 0) {
      console.error(`\nbuild failed for ${t.name} (exit ${code})`);
      process.exit(code);
    }

    const file = t.windows ? `${base}.exe` : base;
    const artifact = Bun.file(join(OUT, file));
    if (!(await artifact.exists())) {
      console.error(`\n${file} was not produced`);
      process.exit(1);
    }
    built.push({ file, bytes: artifact.size });
  }

  // Checksums let an installer verify a download without a second request.
  const sums: string[] = [];
  for (const { file } of built) {
    const bytes = new Uint8Array(await Bun.file(join(OUT, file)).arrayBuffer());
    sums.push(`${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}  ${file}`);
  }
  await Bun.write(join(OUT, 'SHA256SUMS'), `${sums.join('\n')}\n`);

  console.log(`\nshiro-neko ${VERSION}`);
  for (const { file, bytes } of built) console.log(`  ${file.padEnd(26)} ${Math.round(bytes / 1024 / 1024)} MB`);
  console.log(`  ${'SHA256SUMS'.padEnd(26)} ${built.length} entries`);
}

// Guarded so a test can import TARGETS without triggering a five-platform build.
if (import.meta.main) await main();
