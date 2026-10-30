// The markers controller-gen knows, read from its `-wwww` JSON help. Pure: no vscode import.
//
// The built-in copy (src/controller-gen-markers.json, from scripts/capture-markers.sh) is used
// until the workspace's own controller-gen has been asked, and when there is none.

export type MarkerTarget = 'package' | 'type' | 'field';

export interface MarkerArgument {
  // Empty for the anonymous value of `+name=value`.
  name: string;
  // controller-gen's names: string, int, bool, slice, any, raw; `slice` has an itemType.
  type: string;
  itemType?: string;
  optional: boolean;
  summary: string;
  details?: string;
}

export interface MarkerDefinition {
  name: string;
  target: MarkerTarget;
  category: string;
  summary: string;
  details?: string;
  deprecatedInFavorOf?: string;
  arguments: MarkerArgument[];
}

export class MarkerRegistry {
  // One name can be registered for several targets (listType on a field and on a type).
  private readonly byName = new Map<string, MarkerDefinition[]>();

  constructor(definitions: Iterable<MarkerDefinition>) {
    for (const def of definitions) {
      const list = this.byName.get(def.name) ?? [];
      list.push(def);
      this.byName.set(def.name, list);
    }
  }

  static fromHelp(categories: unknown): MarkerRegistry {
    return new MarkerRegistry(parseMarkerHelp(categories));
  }

  get size(): number {
    return this.byName.size;
  }

  lookup(name: string): MarkerDefinition[] {
    return this.byName.get(name) ?? [];
  }

  // Length of the marker name at the start of `body` (the text after `+`), or null if unknown.
  //
  // Mirrors controller-tools splitMarker + tryAnonLookup: everything before the first `=` is
  // tried as a name first (`+kubebuilder:validation:Minimum=1`); failing that, the last
  // `:`-segment is dropped and becomes the first argument's key (`+kubebuilder:resource:scope=X`).
  // Target is ignored: the split is the same whichever target a name is registered for.
  nameLength(body: string): number | null {
    const eq = body.indexOf('=');
    const anonName = eq < 0 ? body : body.slice(0, eq);
    if (this.byName.has(anonName)) return anonName.length;
    if (eq < 0) return null;
    const colon = anonName.lastIndexOf(':');
    if (colon > 0 && this.byName.has(anonName.slice(0, colon))) return colon;
    return null;
  }
}

// Shape of one `controller-gen <gen> -wwww` category, as of v0.19.0. Parsed defensively: other
// versions may add or drop keys, and a definition missing a name or target is skipped.
export function parseMarkerHelp(categories: unknown): MarkerDefinition[] {
  const defs: MarkerDefinition[] = [];
  for (const category of asArray(categories)) {
    for (const marker of asArray(field(category, 'markers'))) {
      const name = str(field(marker, 'name'));
      const target = str(field(marker, 'target'));
      if (!name || (target !== 'package' && target !== 'type' && target !== 'field')) continue;
      defs.push({
        name,
        target,
        category: str(field(marker, 'category')) ?? str(field(category, 'category')) ?? '',
        summary: str(field(marker, 'summary')) ?? '',
        details: str(field(marker, 'details')),
        deprecatedInFavorOf: str(field(marker, 'deprecatedInFavorOf')),
        arguments: asArray(field(marker, 'fields')).map((arg) => ({
          name: str(field(arg, 'name')) ?? '',
          type: str(field(arg, 'type')) ?? '',
          itemType: str(field(field(arg, 'itemType'), 'type')),
          optional: field(arg, 'optional') === true,
          summary: str(field(arg, 'summary')) ?? '',
          details: str(field(arg, 'details')),
        })),
      });
    }
  }
  return defs;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
