// Checks marker comments against the registry. Pure: no vscode import.
//
// Severities follow what controller-gen does (checked against v0.19.0): an unknown argument, a
// missing required one or a value of the wrong type makes it fail, so those are errors; an
// unknown marker, or one where it does not read markers or for another target, is dropped
// without a word, so those are warnings -- they are the ones that cost an afternoon.
import type { MarkerSite, Point, Range } from './analyze.ts';
import {
  argumentType,
  type MarkerArgument,
  type MarkerDefinition,
  type MarkerRegistry,
} from './markers.ts';

export interface MarkerIssue {
  start: Point;
  end: Point;
  severity: 'error' | 'warning' | 'info';
  code:
    | 'unknown-marker'
    | 'ignored-marker'
    | 'wrong-target'
    | 'unknown-argument'
    | 'missing-argument'
    | 'invalid-value'
    | 'deprecated-marker';
  message: string;
  deprecated?: boolean;
  // Replaces the issue's range.
  fix?: { title: string; text: string };
}

// kubebuilder:* is controller-gen's namespace, so a name there that the registry lacks is a
// mistake. kubebuilder:scaffold:* are the Kubebuilder CLI's insertion points, not markers. Other
// namespaces (+k8s:openapi-gen, +genclient, ...) belong to other generators.
const PACKAGE_PLACES =
  'Package markers go above the package clause, or in a comment block separated from the ' +
  'next declaration by a blank line.';

// Markers whose arguments controller-gen parses with their own code (a ParseMarker method), so
// the field list in the help does not describe their syntax: +default=<value> takes a bare value
// though its help lists a field named "value".
const CUSTOM_SYNTAX = new Set(['default']);

function claimed(name: string): boolean {
  return name.startsWith('kubebuilder:') && !name.startsWith('kubebuilder:scaffold:');
}

export function checkMarkers(sites: MarkerSite[], registry: MarkerRegistry): MarkerIssue[] {
  const issues: MarkerIssue[] = [];
  for (const site of sites) checkMarker(site, registry, issues);
  return issues;
}

function checkMarker(site: MarkerSite, registry: MarkerRegistry, issues: MarkerIssue[]): void {
  const { parts } = site;
  const name = parts.nameText;
  const at = ([from, to]: Range) => ({
    start: { row: site.start.row, column: site.start.column + from },
    end: { row: site.start.row, column: site.start.column + to },
  });
  const nameRange = at(parts.name);

  const defs = registry.lookup(name);
  if (defs.length === 0) {
    if (!claimed(name)) return;
    const guess = closest(name, registry.names().filter(claimed));
    const suggestion = guess ? ` Did you mean +${guess}?` : '';
    issues.push({
      ...nameRange,
      severity: 'warning',
      code: 'unknown-marker',
      message: `Unknown marker +${name}; controller-gen ignores it.${suggestion}`,
      fix: guess ? { title: `Change to +${guess}`, text: guess } : undefined,
    });
    return;
  }

  const targets = [...new Set(defs.map((d) => d.target))].sort();
  const where = targets.includes('package') ? ` ${PACKAGE_PLACES}` : '';
  if (site.targets.length === 0) {
    issues.push({
      ...nameRange,
      severity: 'warning',
      code: 'ignored-marker',
      message: `controller-gen does not read markers here, so +${name} is ignored.${where}`,
    });
    return;
  }
  // The first target the marker is defined for wins, as in controller-gen.
  const target = site.targets.find((t) => defs.some((d) => d.target === t));
  const def = defs.find((d) => d.target === target);
  if (!def) {
    const here = site.targets[0];
    issues.push({
      ...nameRange,
      severity: 'warning',
      code: 'wrong-target',
      message:
        `+${name} applies to a ${targets.join(' or ')}, not a ${here}; ` +
        `controller-gen ignores it here.${where}`,
    });
    return;
  }

  if (def.deprecatedInFavorOf) {
    issues.push({
      ...nameRange,
      severity: 'info',
      code: 'deprecated-marker',
      message: `+${name} is deprecated; use +${def.deprecatedInFavorOf}.`,
      deprecated: true,
    });
  }
  if (!CUSTOM_SYNTAX.has(name)) checkArguments(def, site, at, issues);
}

function checkArguments(
  def: MarkerDefinition,
  site: MarkerSite,
  at: (range: Range) => { start: Point; end: Point },
  issues: MarkerIssue[],
): void {
  const { parts } = site;
  const name = parts.nameText;
  const anonymous = def.arguments.find((a) => a.name === '');

  if (anonymous) {
    // The whole text after `=` is one value: commas in it are not argument separators.
    const first = parts.arguments[0];
    if (!first && !anonymous.optional && anonymous.type !== 'bool') {
      // A bool marker alone means true (+kubebuilder:object:root).
      issues.push({
        ...at(parts.name),
        severity: 'error',
        code: 'missing-argument',
        message: `+${name} needs a value: +${name}=<${argumentType(anonymous)}>.`,
      });
    } else if (first && parts.arguments.length === 1) {
      checkValue(anonymous, '', first.value, site, at, issues);
    } else if (first && ['slice', 'int', 'bool'].includes(anonymous.type)) {
      // controller-gen fails with "extra arguments provided". Strings are left alone: whether a
      // bare comma ends one was not checked.
      const extra: Range = [first.value[1], parts.arguments.at(-1)!.value[1]];
      const hint = anonymous.type === 'slice' ? ' List items are separated by ";".' : '';
      issues.push({
        ...at(extra),
        severity: 'error',
        code: 'invalid-value',
        message: `+${name} takes one value; controller-gen rejects the rest.${hint}`,
      });
    }
    return;
  }

  const known = new Map(def.arguments.map((a) => [a.name, a]));
  const seen = new Set<string>();
  for (const arg of parts.arguments) {
    if (!arg.key || arg.keyText === undefined) continue;
    const argument = known.get(arg.keyText);
    if (!argument) {
      const guess = closest(arg.keyText, [...known.keys()]);
      issues.push({
        ...at(arg.key),
        severity: 'error',
        code: 'unknown-argument',
        message:
          `+${name} has no argument "${arg.keyText}".` + (guess ? ` Did you mean "${guess}"?` : ''),
        fix: guess ? { title: `Change to ${guess}`, text: guess } : undefined,
      });
      continue;
    }
    seen.add(arg.keyText);
    checkValue(argument, arg.keyText, arg.value, site, at, issues);
  }
  const missing = def.arguments.filter((a) => !a.optional && !seen.has(a.name));
  if (missing.length > 0) {
    const list = missing.map((a) => `"${a.name}"`).join(', ');
    issues.push({
      ...at(parts.name),
      severity: 'error',
      code: 'missing-argument',
      message: `+${name} is missing required argument${missing.length > 1 ? 's' : ''} ${list}.`,
    });
  }
}

// Only int and bool are checked: strings may be bare or quoted, and any/raw take anything.
function checkValue(
  argument: MarkerArgument,
  key: string,
  [from, to]: Range,
  site: MarkerSite,
  at: (range: Range) => { start: Point; end: Point },
  issues: MarkerIssue[],
): void {
  const text = site.parts.text.slice(from, to);
  const valid =
    argument.type === 'int'
      ? /^-?\d+$/.test(text)
      : argument.type === 'bool'
        ? /^(true|false)$/.test(text)
        : true;
  if (valid) return;
  const what = key ? `"${key}"` : 'the value';
  const expected = argument.type === 'int' ? 'an int' : 'true or false';
  issues.push({
    ...at([from, to]),
    severity: 'error',
    code: 'invalid-value',
    message: `${what} of +${site.parts.nameText} must be ${expected}, not "${text}".`,
  });
}

// The candidate nearest to `word`, if it is near enough to be a typo: a case slip, or a small
// edit distance relative to the length.
function closest(word: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const d = candidate.toLowerCase() === word.toLowerCase() ? 0 : distance(word, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return bestDistance <= Math.max(2, Math.floor(word.length / 8)) ? best : undefined;
}

// Levenshtein distance.
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length]!;
}
