import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { markerHover } from '../src/markerHover.ts';
import { MarkerRegistry } from '../src/markers.ts';

const root = path.resolve(import.meta.dirname, '..');
const builtinPath = path.join(root, 'src/controller-gen-markers.json');
const registry = MarkerRegistry.fromHelp(JSON.parse(readFileSync(builtinPath, 'utf8')).categories);

// Hover at the first occurrence of `at` in the comment; returns the hovered text and markdown.
function hover(comment: string, at: string) {
  const result = markerHover(comment, comment.indexOf(at), registry);
  return result && { over: comment.slice(...result.range), markdown: result.markdown };
}

test('over the name: summary, details and every argument in -ww notation', () => {
  const comment = '// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status`';
  const h = hover(comment, 'printcolumn');
  assert.equal(h?.over, '+kubebuilder:printcolumn');
  assert.match(h!.markdown, /^\*\*`\+kubebuilder:printcolumn`\*\* \*type marker · CRD\*/);
  assert.match(h!.markdown, /adds a column to "kubectl get" output/);
  assert.match(h!.markdown, /^- `JSONPath=<string>` — specifies the jsonpath/m);
  assert.match(h!.markdown, /^- `\[priority=<int>\]` — indicates how important/m);
  // The + belongs to the marker too.
  assert.equal(hover(comment, '+')?.over, '+kubebuilder:printcolumn');
});

test('over an argument: its key and value, type, optionality and owner', () => {
  const comment = '// +kubebuilder:printcolumn:name="Ready",type=string,priority=1';
  const h = hover(comment, 'priority');
  assert.equal(h?.over, 'priority=1');
  assert.match(
    h!.markdown,
    /^\*\*`\[priority=<int>\]`\*\* \*optional, of `\+kubebuilder:printcolumn`\*/,
  );
  assert.match(h!.markdown, /Lower priority/, 'details follow the summary');
  // The first argument sits in the name's path: `name` in printcolumn:name="Ready".
  assert.equal(hover(comment, 'name=')?.over, 'name="Ready"');
  assert.match(hover(comment, '"Ready"')!.markdown, /^\*\*`name=<string>`\*\* \*required/);
});

test('a summary cut mid-sentence carries on into the details', () => {
  const h = hover('// +kubebuilder:validation:XValidation:rule="self > 0"', 'XValidation')!;
  assert.match(h.markdown, /for which a given expression evaluates to true\./);
});

test('anonymous values and slice types', () => {
  assert.match(
    hover('// +kubebuilder:validation:Minimum=1', '1')!.markdown,
    /^\*\*`=<any>`\*\* \*required, of `\+kubebuilder:validation:Minimum`/,
  );
  assert.match(
    hover('// +kubebuilder:rbac:groups=apps,verbs=get', 'verbs')!.markdown,
    /^\*\*`verbs=<\[\]string>`\*\* \*required/,
  );
});

test('one block for targets that share a description, one each otherwise', () => {
  const listType = hover('// +listType=map', 'listType')!.markdown;
  assert.match(listType, /^\*\*`\+listType`\*\* \*field, type marker/);
  assert.ok(!listType.includes('---'));
  const optional = hover('// +kubebuilder:validation:Optional', 'Optional')!.markdown;
  assert.equal(optional.split('\n---\n').length, 2, 'package and field differ in wording');
});

test('deprecated markers name their replacement', () => {
  assert.match(
    hover('// +k8s:deepcopy-gen:interfaces=x', 'k8s')!.markdown,
    /\*\*Deprecated:\*\* use `\+kubebuilder:object:root`/,
  );
});

test('nothing for unknown markers, unknown arguments, or text outside the marker', () => {
  assert.equal(hover('// +kubebuilder:scaffold:imports', 'scaffold'), null);
  assert.equal(hover('// +kubebuilder:resource:bogus=1', 'bogus'), null);
  assert.equal(hover('// +optional  ', '  '), null);
  assert.equal(hover('// not a marker', 'marker'), null);
});
