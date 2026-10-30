// Paints analyze() spans as editor decorations. Decorations sit above both the TextMate grammar
// and gopls semantic tokens, so this works with `gopls.ui.semanticTokens` on -- which would
// flatten a TextMate injection back to one string/comment colour.
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Parser } from 'web-tree-sitter';
import { analyze, type SpanKind } from './analyze.ts';
import builtinMarkers from './controller-gen-markers.json' with { type: 'json' };
import { controllerGenHelp, controllerGenVersion } from './controllerGen.ts';
import { createGoParser } from './goParser.ts';
import { markerHover } from './markerHover.ts';
import { MarkerRegistry } from './markers.ts';

// Doc names and markers live inside comments: by default they keep the theme's comment colour and
// stand out by weight and style only, because a colour would make them read as code. A
// decoration cannot derive a colour from the theme's comment token colour, so the choice is the
// comment colour untouched or a goAnnotations.* theme colour (goAnnotations.comments.useColors).
// Struct tags are code and always use their colours.
const STYLES: Record<SpanKind, { inComment: boolean; fontWeight?: string; fontStyle?: string }> = {
  docCommentName: { inComment: true, fontWeight: 'bold' },
  structTagKey: { inComment: false },
  structTagName: { inComment: false },
  structTagOption: { inComment: false },
  markerPrefix: { inComment: true, fontWeight: 'bold' },
  markerName: { inComment: true, fontWeight: 'bold' },
  markerArgument: { inComment: true, fontStyle: 'italic' },
  markerValue: { inComment: true },
};

const DEBOUNCE_MS = 100;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const parser = await createGoParser(vscode.Uri.joinPath(context.extensionUri, 'dist').fsPath);
  const log = vscode.window.createOutputChannel('Go Annotations', { log: true });
  context.subscriptions.push(
    vscode.commands.registerCommand('goAnnotations.showLog', () => log.show()),
  );
  const builtin = MarkerRegistry.fromHelp(builtinMarkers.categories);
  const painter = new Painter(parser, builtin);
  let markers = builtin;

  // Painting starts with the built-in registry; the workspace's own controller-gen, which may be
  // a different version, replaces it once asked. The generation guards against a slow, stale
  // load finishing after a newer one.
  let generation = 0;
  const reloadMarkers = async () => {
    const mine = ++generation;
    const registry = (await workspaceRegistry(context, log)) ?? builtin;
    if (mine !== generation) return;
    if (registry === builtin) {
      log.info(`Using built-in markers from controller-gen ${builtinMarkers.version}`);
    }
    markers = registry;
    painter.setRegistry(registry);
  };

  // `make controller-gen` usually runs after the editor is open.
  const binWatcher = vscode.workspace.createFileSystemWatcher('**/bin/controller-gen*');
  context.subscriptions.push(
    log,
    painter,
    binWatcher,
    binWatcher.onDidCreate(reloadMarkers),
    binWatcher.onDidChange(reloadMarkers),
    vscode.workspace.onDidGrantWorkspaceTrust(reloadMarkers),
    vscode.workspace.onDidChangeWorkspaceFolders(reloadMarkers),
    vscode.languages.registerHoverProvider('go', {
      provideHover(doc, pos) {
        const config = vscode.workspace.getConfiguration('goAnnotations');
        if (!config.get('markers.enabled', true)) return;
        // controller-gen reads markers from whole-line comments only, so the line is the comment.
        const line = doc.lineAt(pos.line).text;
        const start = line.search(/\S/);
        if (start < 0 || !line.startsWith('//', start)) return;
        const hover = markerHover(line.slice(start), pos.character - start, markers);
        if (!hover) return;
        const [from, to] = hover.range;
        return new vscode.Hover(
          new vscode.MarkdownString(hover.markdown),
          new vscode.Range(pos.line, start + from, pos.line, start + to),
        );
      },
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => painter.paintVisible()),
    vscode.workspace.onDidChangeTextDocument((e) => painter.schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => painter.forget(doc)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('goAnnotations')) painter.reconfigure();
      if (e.affectsConfiguration('goAnnotations.markers.controllerGenPath')) void reloadMarkers();
    }),
  );
  painter.paintVisible();
  void reloadMarkers();
}

// Markers from the first controller-gen that answers: the configured path, then each workspace
// folder's bin/controller-gen (where Kubebuilder's Makefile installs it), then PATH. Running a
// binary from the workspace is code execution, so an untrusted workspace gets the built-in set.
async function workspaceRegistry(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
): Promise<MarkerRegistry | undefined> {
  if (!vscode.workspace.isTrusted) return undefined;
  for (const bin of controllerGenCandidates()) {
    let version: string;
    try {
      version = await controllerGenVersion(bin);
    } catch {
      continue;
    }
    try {
      // A release's markers never change, so its help is cached across sessions; a local build
      // reports `(devel)` and is asked every time.
      const key = `controllerGenHelp/${version}`;
      const cacheable = /^v\d/.test(version);
      let help = cacheable ? context.globalState.get<unknown[]>(key) : undefined;
      if (!help) {
        help = await controllerGenHelp(bin);
        if (cacheable) await context.globalState.update(key, help);
      }
      const registry = MarkerRegistry.fromHelp(help);
      if (registry.size === 0) throw new Error('no markers in its help output');
      log.info(`Using ${registry.size} markers from ${bin} (${version})`);
      return registry;
    } catch (err) {
      log.warn(`Ignoring ${bin} (${version}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return undefined;
}

function controllerGenCandidates(): string[] {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const configured = vscode.workspace
    .getConfiguration('goAnnotations')
    .get<string>('markers.controllerGenPath', '');
  const candidates: string[] = [];
  if (configured) {
    if (path.isAbsolute(configured)) candidates.push(configured);
    else candidates.push(...folders.map((f) => path.join(f, configured)));
  }
  for (const folder of folders) {
    candidates.push(
      path.join(folder, 'bin/controller-gen'),
      path.join(folder, 'bin/controller-gen.exe'),
    );
  }
  // A bare name is looked up on PATH by execFile.
  return [...candidates.filter((c) => existsSync(c)), 'controller-gen'];
}

export function deactivate(): void {}

class Painter implements vscode.Disposable {
  private types = new Map<SpanKind, vscode.TextEditorDecorationType>();
  private timers = new Map<string, NodeJS.Timeout>();
  private cache = new Map<string, { version: number; ranges: Map<SpanKind, vscode.Range[]> }>();
  private readonly parser: Parser;
  private registry: MarkerRegistry;

  constructor(parser: Parser, registry: MarkerRegistry) {
    this.parser = parser;
    this.registry = registry;
    this.createTypes();
  }

  setRegistry(registry: MarkerRegistry): void {
    if (registry === this.registry) return;
    this.registry = registry;
    this.cache.clear();
    this.paintVisible();
  }

  reconfigure(): void {
    this.disposeTypes();
    this.cache.clear();
    this.createTypes();
    this.paintVisible();
  }

  paintVisible(): void {
    for (const editor of vscode.window.visibleTextEditors) this.paint(editor);
  }

  schedule(doc: vscode.TextDocument): void {
    if (doc.languageId !== 'go') return;
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document === doc) this.paint(editor);
        }
      }, DEBOUNCE_MS),
    );
  }

  forget(doc: vscode.TextDocument): void {
    this.cache.delete(doc.uri.toString());
  }

  private paint(editor: vscode.TextEditor): void {
    const doc = editor.document;
    if (doc.languageId !== 'go') return;
    const ranges = this.rangesFor(doc);
    for (const [kind, type] of this.types) editor.setDecorations(type, ranges.get(kind) ?? []);
  }

  private rangesFor(doc: vscode.TextDocument): Map<SpanKind, vscode.Range[]> {
    const key = doc.uri.toString();
    const cached = this.cache.get(key);
    if (cached && cached.version === doc.version) return cached.ranges;

    const config = vscode.workspace.getConfiguration('goAnnotations');
    const tree = this.parser.parse(doc.getText());
    const ranges = new Map<SpanKind, vscode.Range[]>();
    if (tree) {
      const spans = analyze(tree.rootNode, {
        structTags: config.get('structTags.enabled', true),
        docComments: config.get('docComments.enabled', true),
        markers: config.get('markers.enabled', true),
        registry: this.registry,
      });
      tree.delete();
      for (const span of spans) {
        const list = ranges.get(span.kind) ?? [];
        list.push(
          new vscode.Range(span.start.row, span.start.column, span.end.row, span.end.column),
        );
        ranges.set(span.kind, list);
      }
    }
    this.cache.set(key, { version: doc.version, ranges });
    return ranges;
  }

  private createTypes(): void {
    const useColors = vscode.workspace
      .getConfiguration('goAnnotations')
      .get<boolean>('comments.useColors', false);
    for (const kind of Object.keys(STYLES) as SpanKind[]) {
      const style = STYLES[kind];
      const colored = useColors || !style.inComment;
      this.types.set(
        kind,
        vscode.window.createTextEditorDecorationType({
          color: colored ? new vscode.ThemeColor(`goAnnotations.${kind}`) : undefined,
          fontWeight: style.fontWeight,
          fontStyle: style.fontStyle,
        }),
      );
    }
  }

  private disposeTypes(): void {
    for (const type of this.types.values()) type.dispose();
    this.types.clear();
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.disposeTypes();
  }
}
