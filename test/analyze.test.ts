import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { before, describe, test } from 'node:test';
import type { Parser } from 'web-tree-sitter';
import { analyze, type Span, type SpanKind } from '../src/analyze.ts';
import { createGoParser } from '../src/goParser.ts';

const root = path.resolve(import.meta.dirname, '..');
const ALL = { structTags: true, docComments: true, markers: true };

let parser: Parser;
before(async () => {
  parser = await createGoParser(
    path.join(root, 'node_modules/web-tree-sitter'),
    path.join(root, 'node_modules/tree-sitter-go/tree-sitter-go.wasm'),
  );
});

// Each span as "kind text", so expectations read like the source they describe.
function render(source: string, options = ALL): string[] {
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

  test('doc comments are the adjacent group above a declaration, minus markers and directives', () => {
    assert.deepEqual(only(render(source), 'docComment'), [
      '// Package sample 覆盖扩展要识别的每一种写法。',
      '// Spec 是规格：doc comment, then markers in the same group.',
      '// Name 名字。',
      '// Quoted uses an interpreted-string tag.',
      '// Run has a directive above its doc.',
      '// Grouped is documented inside a type group.',
      '// Shape has documented interface methods.',
      '// Area 返回面积。',
    ]);
  });

  test('markers: anonymous values stay in the name, multi-argument markers expose keys', () => {
    const spans = render(source);
    assert.deepEqual(only(spans, 'markerName'), [
      'kubebuilder:object:generate',
      'groupName',
      'kubebuilder:object:root',
      'kubebuilder:printcolumn',
      'kubebuilder:rbac',
      'optional',
      'kubebuilder:validation:MinLength',
    ]);
    assert.deepEqual(only(spans, 'markerArgument'), [
      'name',
      'type',
      'JSONPath',
      'groups',
      'resources',
      'verbs',
    ]);
    assert.ok(
      only(spans, 'markerValue').includes('`.status.conditions[?(@.type=="Ready")].status`'),
      'a backquoted value keeps its inner = and quotes',
    );
    assert.equal(only(spans, 'markerPrefix').length, 7);
  });

  test('columns are UTF-16, matching vscode.Position', () => {
    const comment = '// Area 返回面积。';
    const row = source.split('\n').findIndex((l) => l === `\t${comment}`);
    const tree = parser.parse(source)!;
    const area = analyze(tree.rootNode, ALL).find(
      (s) => s.kind === 'docComment' && s.start.row === row,
    );
    tree.delete();
    // 13 UTF-16 units after the tab; the same text is 23 bytes in UTF-8.
    assert.equal(comment.length, 13);
    assert.deepEqual(area && [area.start.column, area.end.column], [1, 14]);
  });

  test('each feature can be switched off', () => {
    const none = { structTags: false, docComments: false, markers: false };
    assert.deepEqual(render(source, none), []);
    // With markers off, a marker line inside a doc group is plain doc text again.
    assert.ok(
      only(render(source, { ...ALL, markers: false }), 'docComment').includes('// +optional'),
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
