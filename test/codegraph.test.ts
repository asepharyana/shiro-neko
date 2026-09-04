import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { scanCodebase, loadGraph, saveGraph, isGraphFresh } from '../src/codegraph';

const SHIRO_ROOT = join(import.meta.dir, '..');

test('scanCodebase detects source files and generates a summary', () => {
  const graph = scanCodebase(SHIRO_ROOT);

  expect(graph.version).toBe(1);
  expect(Object.keys(graph.files).length).toBeGreaterThan(10);

  // shiro-neko has src/cli.tsx as a core file
  const sourceFiles = Object.keys(graph.files).filter((f) => graph.files[f]?.kind === 'source');
  expect(sourceFiles.length).toBeGreaterThan(20);

  // Summary is populated
  expect(graph.summary).toContain('Codebase Architecture');
  expect(graph.summary).toContain('Modules');
  expect(graph.summary).toContain('Circular deps');
});

test('scanCodebase extracts imports from source files', () => {
  const graph = scanCodebase(SHIRO_ROOT);

  // session.ts should import from prompt.ts
  const sessionNode = graph.files['src/session.ts'];
  expect(sessionNode).toBeDefined();
  expect(sessionNode!.imports.length).toBeGreaterThan(0);
  expect(sessionNode!.imports).toContain('src/prompt.ts');
});

test('scanCodebase detects exported types and functions', () => {
  const graph = scanCodebase(SHIRO_ROOT);

  // config.ts should export a Config type
  const configNode = graph.files['src/config.ts'];
  expect(configNode).toBeDefined();
  expect(configNode!.types.length).toBeGreaterThan(0);
  expect(configNode!.types).toContain('Config');
});

test('scanCodebase detects circular dependencies', () => {
  const graph = scanCodebase(SHIRO_ROOT);

  // shiro-neko has a known circular: providers.ts <-> config.ts
  expect(graph.circularDeps.length).toBeGreaterThanOrEqual(1);
  const hasCircular = graph.circularDeps.some((cycle) =>
    cycle.some((f) => f.includes('providers') || f.includes('config')),
  );
  expect(hasCircular).toBe(true);
});

test('scanCodebase detects entry points', () => {
  const graph = scanCodebase(SHIRO_ROOT);
  // Should detect cli.tsx as an entry point or at least some
  expect(graph.entryPoints.length).toBeGreaterThan(0);
});

test('saveGraph and loadGraph round-trip', () => {
  const graph = scanCodebase(SHIRO_ROOT);
  const dir = mkdtempSync(join(tmpdir(), 'codegraph-test-'));
  saveGraph(dir, graph);
  const loaded = loadGraph(dir);
  expect(loaded).not.toBeNull();
  expect(loaded!.version).toBe(1);
  expect(Object.keys(loaded!.files).length).toBe(Object.keys(graph.files).length);
});

test('isGraphFresh returns true for unchanged files', () => {
  const graph = scanCodebase(SHIRO_ROOT);
  // Graph was just generated from these files, so it should be fresh
  expect(isGraphFresh(SHIRO_ROOT, graph)).toBe(true);
});

test('scanCodebase works on a minimal TypeScript project', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codegraph-min-'));
  // Create a minimal project
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'esnext', module: 'esnext', moduleResolution: 'bundler' },
    include: ['src/**/*.ts'],
  }));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/index.ts'), `
    import { greet } from './greeting';
    export type Config = { name: string };
    export function main(): void { greet('world'); }
  `);
  writeFileSync(join(dir, 'src/greeting.ts'), `
    export function greet(name: string): string { return \`Hello \${name}\`; }
  `);

  const graph = scanCodebase(dir);

  expect(Object.keys(graph.files).length).toBe(2);
  expect(graph.files['src/index.ts']).toBeDefined();
  expect(graph.files['src/greeting.ts']).toBeDefined();
  expect(graph.files['src/index.ts']!.imports).toContain('src/greeting.ts');
  expect(graph.files['src/index.ts']!.types).toContain('Config');
  expect(graph.files['src/index.ts']!.functions).toContain('main');
  expect(graph.files['src/greeting.ts']!.functions).toContain('greet');
  expect(graph.summary).toContain('Modules');
  expect(graph.summary).toContain('src → 2 files');
});
