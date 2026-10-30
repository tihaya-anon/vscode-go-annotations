// Loads web-tree-sitter and the Go grammar from a directory holding both .wasm files: dist/ in the
// packaged extension, node_modules in tests.
import * as path from 'node:path';
import { Language, Parser } from 'web-tree-sitter';

export async function createGoParser(wasmDir: string, grammarPath?: string): Promise<Parser> {
  // Emscripten would otherwise resolve web-tree-sitter.wasm relative to import.meta.url, which a
  // CommonJS bundle does not have.
  await Parser.init({ locateFile: (file: string) => path.join(wasmDir, file) });
  const go = await Language.load(grammarPath ?? path.join(wasmDir, 'tree-sitter-go.wasm'));
  const parser = new Parser();
  parser.setLanguage(go);
  return parser;
}
