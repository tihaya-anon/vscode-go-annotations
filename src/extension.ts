// Paints analyze() spans as editor decorations. Decorations sit above both the TextMate grammar
// and gopls semantic tokens, so this works with `gopls.ui.semanticTokens` on -- which would
// flatten a TextMate injection back to one string/comment colour.
import * as vscode from 'vscode';
import type { Parser } from 'web-tree-sitter';
import { analyze, type SpanKind } from './analyze.ts';
import { createGoParser } from './goParser.ts';

const KINDS: SpanKind[] = [
  'docComment',
  'structTagKey',
  'structTagName',
  'structTagOption',
  'markerPrefix',
  'markerName',
  'markerArgument',
  'markerValue',
];

const DEBOUNCE_MS = 100;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const parser = await createGoParser(vscode.Uri.joinPath(context.extensionUri, 'dist').fsPath);
  const painter = new Painter(parser);
  context.subscriptions.push(
    painter,
    vscode.window.onDidChangeVisibleTextEditors(() => painter.paintVisible()),
    vscode.workspace.onDidChangeTextDocument((e) => painter.schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => painter.forget(doc)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('goAnnotations')) painter.reconfigure();
    }),
  );
  painter.paintVisible();
}

export function deactivate(): void {}

class Painter implements vscode.Disposable {
  private types = new Map<SpanKind, vscode.TextEditorDecorationType>();
  private timers = new Map<string, NodeJS.Timeout>();
  private cache = new Map<string, { version: number; ranges: Map<SpanKind, vscode.Range[]> }>();
  private readonly parser: Parser;

  constructor(parser: Parser) {
    this.parser = parser;
    this.createTypes();
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
    const docStyle = vscode.workspace
      .getConfiguration('goAnnotations')
      .get<string>('docComments.fontStyle', 'italic');
    for (const kind of KINDS) {
      this.types.set(
        kind,
        vscode.window.createTextEditorDecorationType({
          color: new vscode.ThemeColor(`goAnnotations.${kind}`),
          fontStyle: kind === 'docComment' ? docStyle : undefined,
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
