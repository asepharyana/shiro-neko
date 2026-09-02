import { chmodSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '../src/version';

/**
 * Installs the compiled binary onto PATH.
 *
 * `bun link` is not usable here: it writes a shim that re-execs `bun`, so it fails
 * on any machine where bun is installed without `bun.exe` on PATH (an npm install,
 * for one). The compiled binary embeds its own runtime and has no such dependency.
 */
const isWindows = platform() === 'win32';
const exe = isWindows ? 'shiro.exe' : 'shiro';
const source = join(import.meta.dir, '..', 'dist', exe);

const target = (() => {
  const explicit = process.env['SHIRO_INSTALL_DIR'];
  if (explicit) return explicit;
  const bunBin = join(homedir(), '.bun', 'bin');
  return isWindows ? bunBin : join(homedir(), '.local', 'bin');
})();

const built = Bun.file(source);
if (!(await built.exists())) {
  console.error(`shiro: ${source} not found. Run "bun run build" first.`);
  process.exit(1);
}

mkdirSync(target, { recursive: true });
const dest = join(target, exe);

try {
  await Bun.write(dest, built);
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`shiro: could not write ${dest}: ${message}`);
  if (message.includes('EBUSY') || message.includes('EACCES') || message.includes('EPERM')) {
    console.error('shiro: a running shiro may be holding the file. Close it and try again.');
  }
  process.exit(1);
}

if (!isWindows) chmodSync(dest, 0o755);

const onPath = (process.env['PATH'] ?? '').split(isWindows ? ';' : ':').some((p) => p && join(p) === join(target));

console.log(`installed shiro-neko ${VERSION} to ${dest} (${(built.size / 1024 / 1024) | 0} MB)`);
if (onPath) {
  console.log('run: shiro');
} else {
  console.log(`\n${target} is not on PATH. Add it:`);
  console.log(
    isWindows
      ? `  [Environment]::SetEnvironmentVariable('PATH', "$env:PATH;${target}", 'User')`
      : `  export PATH="${target}:$PATH"`,
  );
}
