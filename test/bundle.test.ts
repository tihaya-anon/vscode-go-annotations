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

interface Workspace {
  trusted: boolean;
  folders: string[];
  logs: string[];
  config?: Record<string, unknown>;
  // Options of each decoration type created, in order.
  types?: Array<{ color?: { id: string }; fontWeight?: string; fontStyle?: string }>;
  hover?: HoverProvider;
}

interface HoverProvider {
  provideHover(
    doc: unknown,
    pos: { line: number; character: number },
  ): { contents: { value: string }; range: { start: number[]; end: number[] } } | undefined;
}

function stubVscode(text: string, painted: Painted, ws: Workspace) {
  const noop = () => ({ dispose() {} });
  const log = (line: string) => ws.logs.push(line);
  const lines = text.split('\n');
  const document = {
    languageId: 'go',
    version: 1,
    uri: { toString: () => 'file:///sample.go' },
    getText: () => text,
    lineAt: (line: number) => ({ text: lines[line] }),
  };
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
      createTextEditorDecorationType: (opts: { color?: { id: string } }) => {
        ws.types?.push(opts);
        return { id: opts.color?.id ?? 'uncoloured', dispose() {} };
      },
      createOutputChannel: () => ({ info: log, warn: log, show() {}, dispose() {} }),
    },
    commands: { registerCommand: noop },
    languages: {
      registerHoverProvider: (_selector: string, provider: HoverProvider) => {
        ws.hover = provider;
        return { dispose() {} };
      },
    },
    Hover: class {
      contents: unknown;
      range: unknown;
      constructor(contents: unknown, range: unknown) {
        this.contents = contents;
        this.range = range;
      }
    },
    MarkdownString: class {
      value: string;
      constructor(value: string) {
        this.value = value;
      }
    },
    workspace: {
      isTrusted: ws.trusted,
      workspaceFolders: ws.folders.map((fsPath) => ({ uri: { fsPath } })),
      createFileSystemWatcher: () => ({ onDidCreate: noop, onDidChange: noop, dispose() {} }),
      onDidGrantWorkspaceTrust: noop,
      onDidChangeWorkspaceFolders: noop,
      onDidChangeTextDocument: noop,
      onDidCloseTextDocument: noop,
      onDidChangeConfiguration: noop,
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) => ws.config?.[key] ?? fallback,
      }),
    },
  };
}

async function activate(ws: Workspace, globalState = new Map<string, unknown>()): Promise<Painted> {
  const text = readFileSync(path.join(root, 'test/fixtures/sample.go'), 'utf8');
  const painted: Painted = new Map();
  const vscode = stubVscode(text, painted, ws);

  // Module._load is the hook require() goes through; answer `vscode` with the stub.
  const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
  const original = loader._load;
  loader._load = (request, ...rest) => (request === 'vscode' ? vscode : original(request, ...rest));
  try {
    // A fresh load each time: the bundle binds the stub it was first required with.
    const require = createRequire(import.meta.url);
    delete require.cache[bundle];
    const extension = require(bundle) as {
      activate: (context: unknown) => Promise<void>;
    };
    const subscriptions: unknown[] = [];
    const context = {
      extensionUri: { fsPath: root },
      subscriptions,
      globalState: {
        get: (key: string) => globalState.get(key),
        update: async (key: string, value: unknown) => void globalState.set(key, value),
      },
    };
    await extension.activate(context);
  } finally {
    loader._load = original;
  }
  return painted;
}

// Markers load after activate() returns; wait for the log line that says which set won.
async function markersLoaded(ws: Workspace): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const line = ws.logs.find((l) => l.startsWith('Using '));
    if (line) return line;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`markers never loaded: ${ws.logs.join('; ')}`);
}

const built = !existsSync(bundle) && 'run npm run build first';

test('dist/extension.cjs activates and paints', { skip: built }, async () => {
  // Colours on, so that every decoration type is told apart by its theme colour id.
  const ws = { trusted: false, folders: [root], logs: [], config: { 'comments.useColors': true } };
  const painted = await activate(ws);
  assert.equal(painted.get('goAnnotations.structTagKey')?.length, 4);
  assert.equal(painted.get('goAnnotations.docCommentName')?.length, 14);
  assert.equal(painted.get('goAnnotations.markerName')?.length, 10);
  // The built-in registry is there from the first paint: `scope` is split off its marker.
  assert.equal(painted.get('goAnnotations.markerArgument')?.length, 7);
  // An untrusted workspace never runs controller-gen.
  assert.match(await markersLoaded(ws), /^Using built-in markers/);
});

test('by default, comment decorations keep the comment colour', { skip: built }, async () => {
  const ws: Workspace = { trusted: false, folders: [root], logs: [], types: [] };
  await activate(ws);
  const colours = ws.types!.map((t) => t.color?.id).filter(Boolean);
  assert.deepEqual(colours.sort(), [
    'goAnnotations.structTagKey',
    'goAnnotations.structTagName',
    'goAnnotations.structTagOption',
  ]);
  assert.ok(ws.types!.some((t) => !t.color && t.fontWeight === 'bold'));
});

test('hover describes the marker under the cursor', { skip: built }, async () => {
  const ws: Workspace = { trusted: false, folders: [root], logs: [] };
  await activate(ws);
  const lines = readFileSync(path.join(root, 'test/fixtures/sample.go'), 'utf8').split('\n');
  const line = lines.findIndex((l) => l.startsWith('// +kubebuilder:resource:scope'));
  const doc = { lineAt: (n: number) => ({ text: lines[n] }) };
  const scope = ws.hover!.provideHover(doc, { line, character: lines[line]!.indexOf('scope') });
  assert.match(scope!.contents.value, /^\*\*`\[scope=<string>\]`\*\* \*optional, of `\+kubebuilder:resource`\*/);
  assert.deepEqual([scope!.range.start, scope!.range.end], [
    [line, lines[line]!.indexOf('scope')],
    [line, lines[line]!.length],
  ]);
  assert.equal(
    ws.hover!.provideHover(doc, { line, character: 1 }),
    undefined,
    'the // is not part of the marker',
  );
});

const playground = path.join(root, 'playground');
const noControllerGen =
  !existsSync(path.join(playground, 'bin/controller-gen')) && 'no playground/bin/controller-gen';

test('a trusted workspace uses its bin/controller-gen and caches by version', { skip: built || noControllerGen }, async () => {
  const globalState = new Map<string, unknown>();
  const ws = { trusted: true, folders: [playground], logs: [] };
  await activate(ws, globalState);
  assert.match(await markersLoaded(ws), /^Using \d+ markers from .*playground\/bin\/controller-gen \(v/);
  assert.deepEqual(
    [...globalState.keys()].map((k) => k.replace(/v[\d.]+$/, 'vX')),
    ['controllerGenHelp/vX'],
  );
});
