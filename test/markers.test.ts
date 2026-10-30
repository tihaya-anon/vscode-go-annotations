import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { controllerGenHelp, controllerGenVersion } from '../src/controllerGen.ts';
import { MarkerRegistry, parseMarkerHelp } from '../src/markers.ts';

const root = path.resolve(import.meta.dirname, '..');
const builtinPath = path.join(root, 'src/controller-gen-markers.json');
const builtin = JSON.parse(readFileSync(builtinPath, 'utf8'));

describe('built-in registry', () => {
  const registry = MarkerRegistry.fromHelp(builtin.categories);

  test('covers the crd, rbac, webhook and object generators', () => {
    for (const name of [
      'kubebuilder:validation:Minimum',
      'kubebuilder:rbac',
      'kubebuilder:webhook',
      'kubebuilder:object:root',
    ]) {
      assert.ok(registry.lookup(name).length > 0, name);
    }
  });

  test('keeps arguments, optionality and slice item types', () => {
    const [printcolumn] = registry.lookup('kubebuilder:printcolumn');
    assert.equal(printcolumn?.target, 'type');
    const args = new Map(printcolumn?.arguments.map((a) => [a.name, a]));
    assert.equal(args.get('JSONPath')?.optional, false);
    assert.equal(args.get('priority')?.type, 'int');
    assert.equal(args.get('priority')?.optional, true);
    const [rbac] = registry.lookup('kubebuilder:rbac');
    const verbs = rbac?.arguments.find((a) => a.name === 'verbs');
    assert.deepEqual([verbs?.type, verbs?.itemType], ['slice', 'string']);
  });

  test('a name registered for several targets keeps each', () => {
    const targets = registry.lookup('listType').map((d) => d.target);
    assert.deepEqual(targets.sort(), ['field', 'type']);
  });

  test('markers without arguments have none', () => {
    const [status] = registry.lookup('kubebuilder:subresource:status');
    assert.deepEqual(status?.arguments, []);
  });

  test('deprecated markers name their replacement', () => {
    const [deepcopy] = registry.lookup('k8s:deepcopy-gen:interfaces');
    assert.equal(deepcopy?.deprecatedInFavorOf, 'kubebuilder:object:root');
  });

  test('nameLength: the anonymous name first, then without the last segment', () => {
    const name = (body: string) => {
      const n = registry.nameLength(body);
      return n === null ? null : body.slice(0, n);
    };
    assert.equal(name('kubebuilder:validation:Minimum=1'), 'kubebuilder:validation:Minimum');
    assert.equal(name('kubebuilder:resource:scope=Cluster'), 'kubebuilder:resource');
    assert.equal(name('kubebuilder:rbac:groups=apps,verbs=get'), 'kubebuilder:rbac');
    assert.equal(name('kubebuilder:subresource:status'), 'kubebuilder:subresource:status');
    assert.equal(name('optional'), 'optional');
    // `=` inside a value does not move the split.
    assert.equal(name('kubebuilder:default={a: "b=c"}'), 'kubebuilder:default');
    // Without `=` there is no argument to split off.
    assert.equal(name('kubebuilder:resource:scope'), null);
    assert.equal(name('custom:tool:key=value'), null);
  });
});

describe('parseMarkerHelp', () => {
  test('skips malformed entries instead of throwing', () => {
    const defs = parseMarkerHelp([
      null,
      { markers: 'nope' },
      { category: 'X', markers: [{ name: 'a' }, { name: 'b', target: 'type', fields: null }] },
    ]);
    assert.deepEqual(
      defs.map((d) => [d.name, d.category, d.arguments.length]),
      [['b', 'X', 0]],
    );
    assert.deepEqual(parseMarkerHelp('not json categories'), []);
  });
});

describe('controller-gen', () => {
  // bin/controller-gen is installed by hand; see AGENTS.md.
  const bin = path.join(root, 'bin/controller-gen');
  const skip = !existsSync(bin) && 'no bin/controller-gen';

  test('help from the binary matches the built-in copy of the same version', { skip }, async () => {
    // controller-gen walks Go maps, so the order of markers differs from run to run.
    const sorted = (help: unknown) =>
      parseMarkerHelp(help)
        .map((d) => JSON.stringify(d))
        .sort();
    const live = await controllerGenHelp(bin);
    assert.ok(MarkerRegistry.fromHelp(live).size > 50);
    if ((await controllerGenVersion(bin)) === builtin.version) {
      assert.deepEqual(sorted(live), sorted(builtin.categories));
    }
  });
});
