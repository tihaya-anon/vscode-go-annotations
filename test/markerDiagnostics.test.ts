import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { before, test } from 'node:test';
import type { Parser } from 'web-tree-sitter';
import { analyze } from '../src/analyze.ts';
import { createGoParser } from '../src/goParser.ts';
import { checkMarkers } from '../src/markerDiagnostics.ts';
import { MarkerRegistry } from '../src/markers.ts';

const root = path.resolve(import.meta.dirname, '..');
const builtinPath = path.join(root, 'src/controller-gen-markers.json');
const registry = MarkerRegistry.fromHelp(JSON.parse(readFileSync(builtinPath, 'utf8')).categories);
const source = readFileSync(path.join(root, 'test/fixtures/markers.go'), 'utf8');
const lines = source.split('\n');

let parser: Parser;
before(async () => {
  parser = await createGoParser(
    path.join(root, 'node_modules/web-tree-sitter'),
    path.join(root, 'node_modules/tree-sitter-go/tree-sitter-go.wasm'),
  );
});

function issues() {
  const tree = parser.parse(source)!;
  const { markers } = analyze(tree.rootNode, {
    structTags: false,
    docComments: false,
    markers: true,
    registry,
  });
  tree.delete();
  return checkMarkers(markers, registry).map((i) => ({
    code: i.code,
    severity: i.severity,
    over: lines[i.start.row]!.slice(i.start.column, i.end.column),
    message: i.message,
    fix: i.fix?.text,
  }));
}

test('every kind of mistake in markers.go, and nothing else', () => {
  assert.deepEqual(
    issues().map((i) => `${i.severity} ${i.code}: ${i.over}${i.fix ? ` -> ${i.fix}` : ''}`),
    [
      'warning ignored-marker: kubebuilder:rbac',
      // A trailing comment is not read, even though +optional is a field marker.
      'warning ignored-marker: optional',
      'warning ignored-marker: kubebuilder:validation:MinLength',
      'warning ignored-marker: kubebuilder:validation:Minimum',
      // A package marker in a type's own doc does not fall back to the package.
      'warning wrong-target: kubebuilder:skip',
      'error unknown-argument: bogusArg',
      'error missing-argument: kubebuilder:printcolumn',
      'error invalid-value: high',
      'error unknown-argument: Scope -> scope',
      'info deprecated-marker: k8s:deepcopy-gen:interfaces',
      'warning unknown-marker: kubebuilder:validation:Minimun -> kubebuilder:validation:Minimum',
      'warning wrong-target: kubebuilder:printcolumn',
      'error missing-argument: kubebuilder:validation:MaxLength',
      'error invalid-value: yes',
      'error invalid-value: ,b',
    ],
  );
});

test('messages say what controller-gen does and how to fix it', () => {
  const all = issues();
  const byCode = new Map(all.map((i) => [i.code, i.message]));
  // rbac is a package marker, so the message says where package markers go; Minimum is not.
  const ignored = all.filter((i) => i.code === 'ignored-marker').map((i) => i.message);
  assert.match(ignored[0]!, /\+kubebuilder:rbac is ignored\. Package markers go above/);
  assert.equal(
    ignored.at(-1),
    'controller-gen does not read markers here, so +kubebuilder:validation:Minimum is ignored.',
  );
  const wrong = all.filter((i) => i.code === 'wrong-target').map((i) => i.message);
  assert.match(
    wrong[0]!,
    /^\+kubebuilder:skip applies to a package, not a type; .*Package markers go/,
  );
  assert.equal(
    wrong[1],
    '+kubebuilder:printcolumn applies to a type, not a field; controller-gen ignores it here.',
  );
  assert.deepEqual(
    all.filter((i) => i.code === 'missing-argument').map((i) => i.message),
    [
      '+kubebuilder:printcolumn is missing required argument "type".',
      '+kubebuilder:validation:MaxLength needs a value: +kubebuilder:validation:MaxLength=<int>.',
    ],
  );
  assert.equal(
    byCode.get('deprecated-marker'),
    '+k8s:deepcopy-gen:interfaces is deprecated; use +kubebuilder:object:root.',
  );
});
