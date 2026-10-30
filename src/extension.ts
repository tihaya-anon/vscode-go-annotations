// Paints analyze() spans as editor decorations. Decorations sit above both the TextMate grammar
// and gopls semantic tokens, so this works with `gopls.ui.semanticTokens` on -- which would
// flatten a TextMate injection back to one string/comment colour.
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Parser } from 'web-tree-sitter';
import { analyze, type DocIssue, type SpanKind } from './analyze.ts';
import type { MarkerTarget } from './markers.ts';
import { completeMarker } from './markerCompletion.ts';
import { checkMarkers, type MarkerIssue } from './markerDiagnostics.ts';
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
//
// markerArgumentPair is a faint rounded block behind each `key=value` of a marker, tinted with the
// text's own colour (the comment colour), so it suits any theme without a colour of its own.
//
// It is painted on the text's own span, not with `backgroundColor`: VS Code draws that in a layer
// one line high, so blocks on consecutive lines touched. An inline span's background covers only
// the font's height, leaving a gap. There is no option for it, so the CSS goes in through
// `textDecoration`, which VS Code copies into the inline style verbatim; if that ever stops
// working, the blocks disappear and nothing else changes. The tint cannot be a contributed theme
// colour: VS Code defines no CSS variable for extension colours (seen in DevTools: the rule was
// there, the variable empty), so `var()` of one came out transparent and 0.1.0 shipped without
// blocks. The colour API resolves theme colours only for its own options, not this string.
const ARGUMENT_BLOCK =
  'none; background-color: color-mix(in srgb, currentColor 14%, transparent); border-radius: 3px';
const STYLES: Record<
  SpanKind,
  { inComment: boolean; fontWeight?: string; fontStyle?: string; background?: boolean }
> = {
  docCommentName: { inComment: true, fontWeight: 'bold' },
  structTagKey: { inComment: false },
  structTagName: { inComment: false },
  structTagOption: { inComment: false },
  markerPrefix: { inComment: true, fontWeight: 'bold' },
  markerName: { inComment: true, fontWeight: 'bold' },
  markerArgument: { inComment: true, fontStyle: 'italic' },
  markerValue: { inComment: true },
  markerArgumentPair: { inComment: true, background: true },
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
    vscode.languages.registerCompletionItemProvider(
      'go',
      {
        provideCompletionItems(doc, pos) {
          const config = vscode.workspace.getConfiguration('goAnnotations');
          if (!config.get('markers.enabled', true)) return;
          const line = doc.lineAt(pos.line).text;
          const start = line.search(/\S/);
          if (start < 0 || !line.startsWith('//', start)) return;
          const targets = painter.analysis(doc).targets.get(pos.line) ?? [];
          return completeMarker(line.slice(start), pos.character - start, targets, markers).map(
            (c) => {
              const item = new vscode.CompletionItem(
                c.label,
                c.kind === 'marker'
                  ? vscode.CompletionItemKind.Keyword
                  : vscode.CompletionItemKind.Property,
              );
              item.range = new vscode.Range(
                pos.line,
                start + c.range[0],
                pos.line,
                start + c.range[1],
              );
              item.insertText = c.insertText;
              item.detail = c.detail;
              item.documentation = new vscode.MarkdownString(c.documentation);
              item.sortText = c.sortText;
              if (c.retrigger)
                item.command = { command: 'editor.action.triggerSuggest', title: '' };
              return item;
            },
          );
        },
      },
      '+',
      ':',
      ',',
    ),
    vscode.languages.registerCodeActionsProvider('go', quickFixes(painter), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
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
      // v2: the generator list grew; help cached under the old key lacks applyconfiguration.
      const key = `controllerGenHelp/v2/${version}`;
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
  private cache = new Map<string, Analysed>();
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('go-annotations');
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
    this.diagnostics.delete(doc.uri);
  }

  private paint(editor: vscode.TextEditor): void {
    const doc = editor.document;
    if (doc.languageId !== 'go') return;
    const { ranges } = this.analysis(doc);
    for (const [kind, type] of this.types) editor.setDecorations(type, ranges.get(kind) ?? []);
  }

  // The document as it is now, analysed at most once per version.
  analysis(doc: vscode.TextDocument): Analysed {
    const key = doc.uri.toString();
    const cached = this.cache.get(key);
    if (cached && cached.version === doc.version) return cached;

    const config = vscode.workspace.getConfiguration('goAnnotations');
    const tree = this.parser.parse(doc.getText());
    const ranges = new Map<SpanKind, vscode.Range[]>();
    let docIssues: DocIssue[] = [];
    let markerIssues: MarkerIssue[] = [];
    let targets = new Map<number, MarkerTarget[]>();
    if (tree) {
      const analysis = analyze(tree.rootNode, {
        structTags: config.get('structTags.enabled', true),
        docComments: config.get('docComments.enabled', true),
        docStart: config.get('docComments.checkStart', true),
        markers: config.get('markers.enabled', true),
        registry: this.registry,
      });
      tree.delete();
      docIssues = analysis.docIssues;
      targets = analysis.targets;
      if (config.get('markers.diagnostics', true)) {
        markerIssues = checkMarkers(analysis.markers, this.registry);
      }
      for (const span of analysis.spans) {
        const list = ranges.get(span.kind) ?? [];
        list.push(
          new vscode.Range(span.start.row, span.start.column, span.end.row, span.end.column),
        );
        ranges.set(span.kind, list);
      }
    }
    this.diagnostics.set(doc.uri, [
      ...docIssues.map(docDiagnostic),
      ...markerIssues.map(markerDiagnostic),
    ]);
    const analysed = { version: doc.version, ranges, docIssues, markerIssues, targets };
    this.cache.set(key, analysed);
    return analysed;
  }

  private createTypes(): void {
    const config = vscode.workspace.getConfiguration('goAnnotations');
    const useColors = config.get<boolean>('comments.useColors', false);
    const blocks = config.get<boolean>('markers.argumentBlocks', true);
    for (const kind of Object.keys(STYLES) as SpanKind[]) {
      const style = STYLES[kind];
      const colored = !style.background && (useColors || !style.inComment);
      this.types.set(
        kind,
        vscode.window.createTextEditorDecorationType({
          color: colored ? new vscode.ThemeColor(`goAnnotations.${kind}`) : undefined,
          textDecoration: style.background && blocks ? ARGUMENT_BLOCK : undefined,
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
    this.diagnostics.dispose();
  }
}

interface Analysed {
  version: number;
  ranges: Map<SpanKind, vscode.Range[]>;
  docIssues: DocIssue[];
  markerIssues: MarkerIssue[];
  targets: Map<number, MarkerTarget[]>;
}

function issueRange(issue: DocIssue | MarkerIssue): vscode.Range {
  return new vscode.Range(issue.start.row, issue.start.column, issue.end.row, issue.end.column);
}

function docDiagnostic(issue: DocIssue): vscode.Diagnostic {
  const names = issue.names.map((n) => `"${n}"`).join(' or ');
  const d = new vscode.Diagnostic(
    issueRange(issue),
    `Doc comment should start with ${names}, the name it documents.`,
    vscode.DiagnosticSeverity.Warning,
  );
  d.source = 'go-annotations';
  d.code = 'doc-start';
  return d;
}

const SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

function markerDiagnostic(issue: MarkerIssue): vscode.Diagnostic {
  const d = new vscode.Diagnostic(issueRange(issue), issue.message, SEVERITY[issue.severity]);
  d.source = 'go-annotations';
  d.code = issue.code;
  if (issue.deprecated) d.tags = [vscode.DiagnosticTag.Deprecated];
  return d;
}

// One action per fix the analyzer offers. For a doc start the first, a Go name, is preferred.
function quickFixes(painter: Painter): vscode.CodeActionProvider {
  const fix = (doc: vscode.TextDocument, at: vscode.Range, title: string, text: string) => {
    const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(doc.uri, at, text);
    return action;
  };
  return {
    provideCodeActions(doc, range, context) {
      const ours = context.diagnostics.filter((d) => d.source === 'go-annotations');
      if (ours.length === 0) return [];
      const { docIssues, markerIssues } = painter.analysis(doc);
      const actions: vscode.CodeAction[] = [];
      for (const issue of markerIssues) {
        const at = issueRange(issue);
        if (!issue.fix || !at.intersection(range)) continue;
        const action = fix(doc, at, issue.fix.title, issue.fix.text);
        action.diagnostics = ours.filter((d) => d.range.isEqual(at));
        action.isPreferred = true;
        actions.push(action);
      }
      for (const issue of docIssues) {
        const at = issueRange(issue);
        if (!at.intersection(range)) continue;
        issue.fixes.forEach(({ name, text }, i) => {
          const title =
            text === name
              ? `Change "${issue.word}" to "${name}"`
              : `Start the doc comment with "${name}"`;
          const action = fix(doc, at, title, text);
          action.diagnostics = ours.filter((d) => d.range.isEqual(at));
          action.isPreferred = i === 0;
          actions.push(action);
        });
      }
      return actions;
    },
  };
}
