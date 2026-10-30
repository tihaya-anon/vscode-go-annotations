import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { completeMarker } from '../src/markerCompletion.ts';
import { MarkerRegistry, type MarkerTarget } from '../src/markers.ts';

const root = path.resolve(import.meta.dirname, '..');
const builtinPath = path.join(root, 'src/controller-gen-markers.json');
const registry = MarkerRegistry.fromHelp(JSON.parse(readFileSync(builtinPath, 'utf8')).categories);

// `|` marks the cursor.
function complete(line: string, targets: MarkerTarget[] = ['field']) {
  const offset = line.indexOf('|');
  const text = line.replace('|', '');
  return completeMarker(text, offset, targets, registry).map((c) => ({
    ...c,
    replaces: text.slice(...c.range),
  }));
}

test('after `// +`: marker names for the target, with what follows the name', () => {
  const items = complete('// +|');
  const labels = items.map((i) => i.label);
  assert.ok(labels.includes('kubebuilder:validation:Minimum'));
  assert.ok(!labels.includes('kubebuilder:printcolumn'), 'a type marker is not offered on a field');
  const insert = new Map(items.map((i) => [i.label, i.insertText]));
  assert.equal(insert.get('kubebuilder:validation:Minimum'), 'kubebuilder:validation:Minimum=');
  assert.equal(
    insert.get('kubebuilder:validation:XValidation'),
    'kubebuilder:validation:XValidation:',
  );
  assert.equal(insert.get('optional'), 'optional');
  assert.ok(items.find((i) => i.label === 'kubebuilder:validation:XValidation')!.retrigger);
});

test('above a type, package markers are offered too', () => {
  const labels = complete('// +|', ['type', 'package']).map((i) => i.label);
  assert.ok(labels.includes('kubebuilder:printcolumn'));
  assert.ok(labels.includes('kubebuilder:webhook'));
  assert.ok(!labels.includes('optional'), 'a field-only marker');
});

test('a partly typed name is replaced whole, also the part after the cursor', () => {
  const [item] = complete('// +kubebuilder:valid|ation:Min', ['field']);
  assert.equal(item?.replaces, 'kubebuilder:validation:Min');
});

test('after `name:` and `,`: unused argument names, required first', () => {
  const first = complete('// +kubebuilder:printcolumn:|', ['type']);
  assert.deepEqual(
    first.sort((a, b) => a.sortText.localeCompare(b.sortText)).map((i) => i.label),
    ['JSONPath', 'name', 'type', 'description', 'format', 'priority'],
  );
  assert.equal(first.find((i) => i.label === 'name')!.insertText, 'name=');
  assert.equal(first.find((i) => i.label === 'name')!.detail, 'required string');

  const later = complete('// +kubebuilder:printcolumn:name="Ready",ty|', ['type']);
  assert.ok(!later.some((i) => i.label === 'name'), 'name is already given');
  assert.equal(later.find((i) => i.label === 'type')?.replaces, 'ty');
});

test('nothing inside a value or outside the marker', () => {
  assert.deepEqual(complete('// +kubebuilder:printcolumn:name=|', ['type']), []);
  assert.deepEqual(complete('// +kubebuilder:validation:Minimum=|'), []);
  assert.deepEqual(complete('/|/ +optional'), []);
  assert.deepEqual(complete('// plain text|'), []);
});
