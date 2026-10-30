// Bundles the extension into dist/ and copies the two .wasm files next to it, where
// createGoParser() looks for them at runtime.
import { copyFile, mkdir } from 'node:fs/promises';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
// The packaged extension: minified, and without source maps, which would double its size.
const production = process.argv.includes('--production');

await mkdir('dist', { recursive: true });
await Promise.all([
  copyFile('node_modules/web-tree-sitter/web-tree-sitter.wasm', 'dist/web-tree-sitter.wasm'),
  copyFile('node_modules/tree-sitter-go/tree-sitter-go.wasm', 'dist/tree-sitter-go.wasm'),
]);

const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  bundle: true,
  // The extension host loads extensions with require().
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  // web-tree-sitter ships as ESM and calls createRequire(import.meta.url), which a CommonJS
  // bundle leaves undefined. Give it the bundle's own file URL instead.
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__importMetaUrl' },
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

if (watch) {
  await (await esbuild.context(options)).watch();
} else {
  await esbuild.build(options);
}
