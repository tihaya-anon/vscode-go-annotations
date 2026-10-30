import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { before, describe, test } from 'node:test';
import type { Parser } from 'web-tree-sitter';
import { analyze, type AnalyzeOptions, type Span, type SpanKind } from '../src/analyze.ts';
import { createGoParser } from '../src/goParser.ts';
import { MarkerRegistry } from '../src/markers.ts';

const root = path.resolve(import.meta.dirname, '..');
const builtinPath = path.join(root, 'src/controller-gen-markers.json');
const builtin = JSON.parse(readFileSync(builtinPath, 'utf8'));
const registry = MarkerRegistry.fromHelp(builtin.categories);
const ALL: AnalyzeOptions = { structTags: true, docComments: true, markers: true, registry };

let parser: Parser;
before(async () => {
  parser = await createGoParser(
    path.join(root, 'node_modules/web-tree-sitter'),
    path.join(root, 'node_modules/tree-sitter-go/tree-sitter-go.wasm'),
  );
});

// Each span as "kind text", so expectations read like the source they describe.
function render(source: string, options: AnalyzeOptions = ALL): string[] {
  const tree = parser.parse(source)!;
  const lines = source.split('\n');
  const out = analyze(tree.rootNode, options).map((s: Span) => {
    const text =
      s.start.row === s.end.row
        ? lines[s.start.row]!.slice(s.start.column, s.end.column)
        : `${lines[s.start.row]!.slice(s.start.column)}...`;
    return `${s.kind} ${text}`;
  });
  tree.delete();
  return out;
}

function only(spans: string[], kind: SpanKind): string[] {
  return spans.filter((s) => s.startsWith(`${kind} `)).map((s) => s.slice(kind.length + 1));
}

describe('sample.go', () => {
  const source = readFileSync(path.join(root, 'test/fixtures/sample.go'), 'utf8');

  test('struct tags split into key, name and options', () => {
    const spans = render(source);
    assert.deepEqual(only(spans, 'structTagKey'), ['json', 'yaml', 'json', 'json']);
    assert.deepEqual(only(spans, 'structTagName'), ['name', 'name', 'plain', 'quoted']);
    assert.deepEqual(only(spans, 'structTagOption'), ['omitempty', 'string']);
  });

  test('doc comments: whole-word mentions of the declared name, in the adjacent group only', () => {
    assert.deepEqual(only(render(source), 'docCommentName'), [
      'sample',
      'Spec',
      'Name',
      'Quoted',
      'Run',
      'Grouped',
      'Shape',
      'Area',
      'Area',
      // Embedded *Grouped is named after its type; `X, Y int` declares both. NotX and X2 are
      // other words.
      'Grouped',
      'X',
      'Y',
      // A block comment, across its two lines.
      'Block',
      'Block',
    ]);
  });

  test('markers: the registry splits name from first argument', () => {
    const spans = render(source);
    assert.deepEqual(only(spans, 'markerName'), [
      'kubebuilder:object:generate',
      'groupName',
      'kubebuilder:object:root',
      'kubebuilder:printcolumn',
      'kubebuilder:rbac',
      'kubebuilder:resource',
      'kubebuilder:subresource:status',
      'optional',
      'kubebuilder:validation:MinLength',
      'custom:tool:key',
    ]);
    assert.deepEqual(only(spans, 'markerArgument'), [
      'name',
      'type',
      'JSONPath',
      'groups',
      'resources',
      'verbs',
      'scope',
    ]);
    assert.ok(
      only(spans, 'markerValue').includes('`.status.conditions[?(@.type=="Ready")].status`'),
      'a backquoted value keeps its inner = and quotes',
    );
    assert.equal(only(spans, 'markerPrefix').length, 10);
  });

  test('markers: without a registry, only multi-argument markers expose a first key', () => {
    const spans = render(source, { ...ALL, registry: undefined });
    assert.ok(only(spans, 'markerName').includes('kubebuilder:resource:scope'));
    assert.ok(only(spans, 'markerName').includes('kubebuilder:printcolumn'));
    assert.ok(!only(spans, 'markerArgument').includes('scope'));
  });

  test('columns are UTF-16, matching vscode.Position', () => {
    const line = '\t// Area 返回面积，即 Area。';
    const row = source.split('\n').indexOf(line);
    const tree = parser.parse(source)!;
    const areas = analyze(tree.rootNode, ALL).filter(
      (s) => s.kind === 'docCommentName' && s.start.row === row,
    );
    tree.delete();
    // The second Area follows 6 CJK characters: 6 UTF-16 units, but 18 bytes in UTF-8.
    assert.equal(line.indexOf('Area', 5), 16);
    assert.deepEqual(
      areas.map((s) => [s.start.column, s.end.column]),
      [
        [4, 8],
        [16, 20],
      ],
    );
  });

  test('each feature can be switched off', () => {
    const none = { structTags: false, docComments: false, markers: false };
    assert.deepEqual(render(source, none), []);
    assert.deepEqual(
      render(source, { ...ALL, markers: false }).filter((s) => s.startsWith('marker')),
      [],
    );
  });
});

describe('playground', () => {
  // A smoke test over real Kubebuilder output: every span must fall inside its line.
  const dir = path.join(root, 'playground/api/v1alpha1');
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.go'));
  } catch {
    // playground/ is gitignored; scripts/make-playground.sh creates it.
  }

  test('api/v1alpha1 spans stay within their lines', { skip: files.length === 0 }, () => {
    for (const file of files) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      const lines = source.split('\n');
      const tree = parser.parse(source)!;
      for (const s of analyze(tree.rootNode, ALL)) {
        assert.ok(s.end.column <= lines[s.end.row]!.length, `${file}:${s.end.row + 1}`);
        assert.ok(
          s.start.row < s.end.row || s.start.column < s.end.column,
          `${file}:${s.start.row + 1}`,
        );
      }
      tree.delete();
    }
  });
});
