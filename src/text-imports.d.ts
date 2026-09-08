/**
 * Lets TypeScript resolve Bun's raw-text imports of `.md` files.
 *
 * `import x from './file.md' with { type: 'text' }` returns the file's contents as
 * a string; tsc does not know that without a module declaration. Bun handles the
 * actual loading (and inlines it into a compiled binary); this only teaches the
 * typechecker the shape.
 */
declare module '*.md' {
  const content: string;
  export default content;
}

declare module '*.png' {
  const content: ArrayBuffer;
  export default content;
}
