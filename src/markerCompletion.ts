// Completion inside a `// +` marker comment, from the registry. Pure: no vscode import.
import { keyOf, splitTopLevel, type Range } from './analyze.ts';
import { describeArgument, describeMarker } from './markerHover.ts';
import {
  argumentType,
  type MarkerDefinition,
  type MarkerRegistry,
  type MarkerTarget,
} from './markers.ts';

export interface MarkerCompletion {
  label: string;
  kind: 'marker' | 'argument';
  // Offsets into the comment text that the completion replaces.
  range: Range;
  insertText: string;
  detail: string;
  documentation: string;
  sortText: string;
  // Open completion again after inserting: argument names follow `name:`.
  retrigger: boolean;
}

const NAME_CHAR = /[\w:.\/-]/;

// `text` is a whole-line `//` comment, `offset` the cursor in it, `targets` what a marker there
// would attach to (empty where controller-gen ignores markers; then nothing is filtered out).
export function completeMarker(
  text: string,
  offset: number,
  targets: MarkerTarget[],
  registry: MarkerRegistry,
): MarkerCompletion[] {
  const head = /^\/\/\s*\+/.exec(text);
  if (!head || offset < head[0].length) return [];
  const bodyStart = head[0].length;
  const typed = text.slice(bodyStart, offset);
  return (
    completeArgument(text, bodyStart, offset, targets, registry) ??
    (/^[\w:.\/-]*$/.test(typed) ? completeName(text, bodyStart, targets, registry) : [])
  );
}

function completeName(
  text: string,
  bodyStart: number,
  targets: MarkerTarget[],
  registry: MarkerRegistry,
): MarkerCompletion[] {
  let end = bodyStart;
  while (end < text.length && NAME_CHAR.test(text[end]!)) end++;
  const items: MarkerCompletion[] = [];
  for (const name of registry.names()) {
    const defs = registry.lookup(name);
    const def = preferred(defs, targets);
    if (!def) continue;
    const anonymous = def.arguments.some((a) => a.name === '');
    const suffix = def.arguments.length === 0 ? '' : anonymous ? '=' : ':';
    items.push({
      label: name,
      kind: 'marker',
      range: [bodyStart, end],
      insertText: name + suffix,
      detail: `${def.target} marker · ${def.category}`,
      documentation: describeMarker(name, defs),
      sortText: name,
      retrigger: suffix === ':',
    });
  }
  return items;
}

// After `+name:` or a later `,`, where an argument key goes. Null when the cursor is not in an
// argument list of a marker the registry knows, so that names are completed instead.
function completeArgument(
  text: string,
  bodyStart: number,
  offset: number,
  targets: MarkerTarget[],
  registry: MarkerRegistry,
): MarkerCompletion[] | null {
  const body = text.slice(bodyStart, offset);
  // The longest known name followed by `:`; shorter ones are path segments of it.
  let name: string | undefined;
  for (const candidate of registry.names()) {
    if (body.startsWith(`${candidate}:`) && candidate.length > (name?.length ?? -1))
      name = candidate;
  }
  if (!name) return null;
  const def = preferred(registry.lookup(name), targets) ?? registry.lookup(name)[0]!;
  if (def.arguments.length === 0 || def.arguments.some((a) => a.name === '')) return null;

  const listStart = bodyStart + name.length + 1;
  const pieces = splitTopLevel(text, listStart, offset);
  const [from] = pieces.at(-1)!;
  // In a value: nothing to offer.
  if (text.slice(from, offset).includes('=')) return [];
  let end = offset;
  while (end < text.length && /\w/.test(text[end]!)) end++;
  const used = new Set(
    pieces.slice(0, -1).flatMap((p) => {
      const eq = keyOf(text, p);
      return eq === null ? [] : [text.slice(p[0], eq)];
    }),
  );
  return def.arguments
    .filter((a) => !used.has(a.name))
    .map((a) => ({
      label: a.name,
      kind: 'argument' as const,
      range: [from, end] as Range,
      insertText: `${a.name}=`,
      detail: `${a.optional ? 'optional' : 'required'} ${argumentType(a)}`,
      documentation: describeArgument(name, a),
      // Required arguments first.
      sortText: `${a.optional ? 1 : 0}${a.name}`,
      retrigger: false,
    }));
}

// The definition for the first of `targets` that has one; with no targets (a place controller-gen
// ignores), any definition.
function preferred(
  defs: MarkerDefinition[],
  targets: MarkerTarget[],
): MarkerDefinition | undefined {
  if (targets.length === 0) return defs[0];
  for (const target of targets) {
    const def = defs.find((d) => d.target === target);
    if (def) return def;
  }
  return undefined;
}
