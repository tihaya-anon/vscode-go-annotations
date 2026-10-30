// Loads the built dist/extension.cjs the way the extension host does -- require() -- against a
// stub `vscode` module, and checks that activation paints decorations. This is what catches a
// bundle that cannot find its .wasm files or trips over import.meta in CommonJS.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import * as path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const bundle = path.join(root, 'dist/extension.cjs');

type Painted = Map<string, Array<{ start: number[]; end: number[] }>>;

function stubVscode(text: string, painted: Painted) {
  const noop = () => ({ dispose() {} });
  const document = { languageId: 'go', version: 1, uri: { toString: () => 'file:///sample.go' }, getText: () => text };
  const editor = {
    document,
    setDecorations(type: { id: string }, ranges: Array<{ start: number[]; end: number[] }>) {
      painted.set(type.id, ranges);
    },
  };
  return {
    Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
    ThemeColor: class {
      id: string;
      constructor(id: string) {
        this.id = id;
      }
    },
    Range: class {
      start: number[];
      end: number[];
      constructor(sl: number, sc: number, el: number, ec: number) {
        this.start = [sl, sc];
        this.end = [el, ec];
      }
    },
    window: {
      visibleTextEditors: [editor],
      onDidChangeVisibleTextEditors: noop,
      createTextEditorDecorationType: (opts: { color: { id: string } }) => ({ id: opts.color.id, dispose() {} }),
    },
    workspace: {
      onDidChangeTextDocument: noop,
      onDidCloseTextDocument: noop,
      onDidChangeConfiguration: noop,
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    },
  };
}

test('dist/extension.cjs activates and paints', { skip: !existsSync(bundle) && 'run npm run build first' }, async () => {
  const text = readFileSync(path.join(root, 'test/fixtures/sample.go'), 'utf8');
  const painted: Painted = new Map();
  const vscode = stubVscode(text, painted);

  // Module._load is the hook require() goes through; answer `vscode` with the stub.
  const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
  const original = loader._load;
  loader._load = (request, ...rest) => (request === 'vscode' ? vscode : original(request, ...rest));
  try {
    const extension = createRequire(import.meta.url)(bundle) as {
      activate: (context: unknown) => Promise<void>;
    };
    const subscriptions: unknown[] = [];
    await extension.activate({ extensionUri: { fsPath: root }, subscriptions });
  } finally {
    loader._load = original;
  }

  assert.equal(painted.get('goAnnotations.structTagKey')?.length, 4);
  assert.equal(painted.get('goAnnotations.docComment')?.length, 8);
  assert.equal(painted.get('goAnnotations.markerName')?.length, 7);
});
