// Hover text for a controller-gen marker, from the registry. Pure: no vscode import; the
// extension turns the result into a vscode.Hover.
import { parseMarker, type Range } from './analyze.ts';
import type { MarkerArgument, MarkerDefinition, MarkerRegistry } from './markers.ts';

export interface MarkerHover {
  markdown: string;
  // Offsets into the comment text that the hover applies to.
  range: Range;
}

// `text` is a one-line comment, `offset` the hovered position in it. Over the `+` or the name, the
// marker is described; over an argument's key or value, that argument. Null for anything else,
// including markers the registry does not know.
export function markerHover(
  text: string,
  offset: number,
  registry: MarkerRegistry,
): MarkerHover | null {
  const marker = parseMarker(text, registry);
  if (!marker) return null;
  const defs = registry.lookup(marker.nameText);
  if (defs.length === 0) return null;

  if (offset >= marker.prefix && offset < marker.name[1]) {
    const range: Range = [marker.prefix, marker.name[1]];
    return { markdown: describeMarker(marker.nameText, defs), range };
  }
  for (const arg of marker.arguments) {
    const range: Range = [arg.key?.[0] ?? arg.value[0], arg.value[1]];
    if (offset < range[0] || offset >= range[1]) continue;
    const name = arg.keyText ?? '';
    const argument = defs.flatMap((d) => d.arguments).find((a) => a.name === name);
    if (!argument) return null;
    return { markdown: describeArgument(marker.nameText, argument), range };
  }
  return null;
}

// A name registered for several targets usually has the same text for each (listType on a field
// and on a type); those are shown once with every target listed.
function describeMarker(name: string, defs: MarkerDefinition[]): string {
  const groups = new Map<string, MarkerDefinition[]>();
  for (const def of defs) {
    const key = JSON.stringify([def.summary, def.details, def.deprecatedInFavorOf, def.arguments]);
    groups.set(key, [...(groups.get(key) ?? []), def]);
  }
  const blocks = [...groups.values()].map((group) => {
    const def = group[0]!;
    const targets = group.map((d) => d.target).sort().join(', ');
    // The title in bold (code inherits the weight) and its qualifiers in italics, so the name
    // stands out without a colour that would have to be hard-coded here.
    const lines = [`**\`+${name}\`** *${targets} marker · ${def.category}*`];
    if (def.deprecatedInFavorOf) {
      lines.push(`**Deprecated:** use \`+${def.deprecatedInFavorOf}\`.`);
    }
    lines.push(...prose(def.summary, def.details));
    if (def.arguments.length > 0) {
      const item = (a: MarkerArgument) => `- ${signature(a)}${a.summary ? ` — ${a.summary}` : ''}`;
      lines.push(def.arguments.map(item).join('\n'));
    }
    return lines.join('\n\n');
  });
  return blocks.join('\n\n---\n\n');
}

function describeArgument(marker: string, argument: MarkerArgument): string {
  const need = argument.optional ? 'optional' : 'required';
  const lines = [
    `**${signature(argument)}** *${need}, of \`+${marker}\`*`,
    ...prose(argument.summary, argument.details),
  ];
  return lines.join('\n\n');
}

// controller-gen's own -ww notation: `name=<type>`, `[name=<type>]` when optional, `=<type>` for
// the anonymous value.
function signature(argument: MarkerArgument): string {
  const type =
    argument.type === 'slice' ? `[]${argument.itemType ?? 'any'}` : argument.type || 'any';
  const text = `${argument.name}=<${type}>`;
  return `\`${argument.optional ? `[${text}]` : text}\``;
}

// controller-gen cuts the summary at the first sentence or line, so it often stops mid-sentence
// and details carry on from there: rejoin them.
function prose(summary: string, details: string | undefined): string[] {
  if (summary && details && !/[.!?:;]$/.test(summary)) return [`${summary} ${details}`];
  return [summary, details].filter((s): s is string => !!s);
}
