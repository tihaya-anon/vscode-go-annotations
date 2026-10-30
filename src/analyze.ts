// Turns a tree-sitter-go syntax tree into highlight spans. Pure: no vscode import, so it runs under
// `node --test` against the real parser.
//
// Positions are tree-sitter Points. web-tree-sitter measures columns in UTF-16 code units, the same
// unit as a vscode.Position character, so they map across without conversion.
import type { Node, Point } from 'web-tree-sitter';
import type { MarkerRegistry } from './markers.ts';

export type SpanKind =
  | 'structTagKey'
  | 'structTagName'
  | 'structTagOption'
  | 'docCommentName'
  | 'markerPrefix'
  | 'markerName'
  | 'markerArgument'
  | 'markerValue';

export interface Span {
  kind: SpanKind;
  start: Point;
  end: Point;
}

export interface AnalyzeOptions {
  structTags: boolean;
  docComments: boolean;
  markers: boolean;
  // Splits marker name from first argument exactly; without it, or for a marker it does not know,
  // a lexical guess is used (see parseMarker).
  registry?: MarkerRegistry;
}

// Nodes whose immediately preceding comment group is their doc comment, as go/doc reads it.
const DOCUMENTED = new Set([
  'package_clause',
  'type_declaration',
  'type_spec',
  'type_alias',
  'function_declaration',
  'method_declaration',
  'const_declaration',
  'const_spec',
  'var_declaration',
  'var_spec',
  'field_declaration',
  'method_elem',
]);

// go/doc drops directive lines from doc text (go.dev/doc/comment#syntax), so they are not prose.
const DIRECTIVE = /^\/\/(line |extern |export |[a-z0-9]+:[a-z0-9])/;
// `// +name...`: the controller-gen marker shape. Requiring a name character after `+` keeps
// prose like `// + adds two numbers` out.
const MARKER = /^\/\/\s*\+(?=[A-Za-z_])/;
// `// +build linux`, the pre-Go 1.17 build constraint, has the marker shape but is not one.
const BUILD_CONSTRAINT = /^\/\/\s*\+build(\s|$)/;

export function analyze(root: Node, options: AnalyzeOptions): Span[] {
  const spans: Span[] = [];
  // Doc comment id -> the names its declaration declares.
  const docComments = new Map<number, string[]>();

  walk(root, (node) => {
    if (options.docComments && DOCUMENTED.has(node.type)) {
      const names = declaredNames(node);
      if (names.length > 0) {
        for (const comment of docCommentGroup(node)) docComments.set(comment.id, names);
      }
    }
    if (options.structTags && node.type === 'field_declaration') {
      const tag = node.childForFieldName('tag');
      if (tag) structTagSpans(tag, spans);
    }
    if (node.type === 'comment') {
      const marker = options.markers ? parseMarker(node.text, options.registry) : null;
      if (marker) {
        markerSpans(node, marker, spans);
      } else if (docComments.has(node.id) && !DIRECTIVE.test(node.text)) {
        docNameSpans(node, docComments.get(node.id)!, spans);
      }
    }
  });
  return spans;
}

// Pre-order, and a declaration is visited before the comments that follow it, but its doc
// comments are earlier siblings -- so collect every group first, then classify comments.
function walk(root: Node, visit: (node: Node) => void): void {
  const pending: Node[] = [];
  const all: Node[] = [];
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    all.push(node);
    const children = node.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child) stack.push(child);
    }
  }
  for (const node of all) {
    if (node.type === 'comment') pending.push(node);
    else visit(node);
  }
  for (const comment of pending) visit(comment);
}

// The comment lines directly above a declaration with no blank line in between. A comment that
// shares its first line with earlier code is that code's trailing comment, not this doc.
function docCommentGroup(node: Node): Node[] {
  const group: Node[] = [];
  let nextRow = node.startPosition.row;
  let sibling = node.previousSibling;
  while (sibling && sibling.type === 'comment' && sibling.endPosition.row === nextRow - 1) {
    const before = sibling.previousSibling;
    if (before && before.endPosition.row === sibling.startPosition.row) break;
    group.push(sibling);
    nextRow = sibling.startPosition.row;
    sibling = before;
  }
  return group;
}

// The identifiers a documented node declares, which its doc comment is about. A group
// (`type ( ... )`, `var ( ... )`) declares nothing itself: its specs carry their own docs.
function declaredNames(node: Node): string[] {
  switch (node.type) {
    case 'package_clause':
      return node.namedChildren.filter((c) => c.type === 'package_identifier').map((c) => c.text);
    case 'type_declaration':
    case 'const_declaration':
    case 'var_declaration': {
      if (node.children.some((c) => c.type === '(')) return [];
      const specs = node.namedChildren.filter((c) => c.type !== 'comment');
      return specs.length === 1 ? declaredNames(specs[0]!) : [];
    }
    case 'field_declaration': {
      const names = node.childrenForFieldName('name');
      if (names.length > 0) return names.map((n) => n.text);
      // Embedded field: its name is the type's, without pointer, package or type arguments.
      const type = node.childForFieldName('type');
      const base = type?.type === 'generic_type' ? type.childForFieldName('type') : type;
      const name = base?.type === 'qualified_type' ? base.childForFieldName('name') : base;
      return name ? [name.text] : [];
    }
    default:
      return node.childrenForFieldName('name').map((n) => n.text);
  }
}

// Whole-word, case-sensitive mentions of the declared names inside a doc comment. Go doc comments
// start with the name, so this always finds that one, and also later mentions of it.
function docNameSpans(comment: Node, names: string[], spans: Span[]): void {
  const text = comment.text;
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const at = (offset: number): Point => {
    let line = lineStarts.length - 1;
    while (lineStarts[line]! > offset) line--;
    const column = offset - lineStarts[line]! + (line === 0 ? comment.startPosition.column : 0);
    return { row: comment.startPosition.row + line, column };
  };
  for (const name of names) {
    // A Go identifier is letters, digits and _, so the name needs no escaping.
    const word = new RegExp(`(?<![\\p{L}\\p{N}_])${name}(?![\\p{L}\\p{N}_])`, 'gu');
    for (const match of text.matchAll(word)) {
      const from = match.index;
      spans.push({ kind: 'docCommentName', start: at(from), end: at(from + name.length) });
    }
  }
}

// reflect.StructTag convention: key:"value" pairs separated by spaces; by the encoding/json
// convention the value is a name followed by comma-separated options.
function structTagSpans(tag: Node, spans: Span[]): void {
  const text = tag.text;
  if (text.includes('\n')) return;
  const raw = tag.type === 'raw_string_literal';
  // In an interpreted literal the tag's own quotes are written \" in source.
  const quote = raw ? '"' : '\\"';
  const body = text.slice(1, -1);
  const base = tag.startPosition;
  const at = (offset: number): Point => ({ row: base.row, column: base.column + 1 + offset });
  const push = (kind: SpanKind, from: number, to: number) => {
    if (to > from) spans.push({ kind, start: at(from), end: at(to) });
  };

  let i = 0;
  while (i < body.length) {
    while (body[i] === ' ') i++;
    const keyStart = i;
    while (i < body.length && body[i] !== ':' && body[i] !== ' ' && body[i] !== '"') i++;
    const keyEnd = i;
    if (keyEnd === keyStart || body[i] !== ':' || !body.startsWith(quote, i + 1)) return;
    push('structTagKey', keyStart, keyEnd);
    i += 1 + quote.length;

    const valueStart = i;
    while (i < body.length && !body.startsWith(quote, i)) i += body[i] === '\\' && raw ? 2 : 1;
    if (i >= body.length) return;
    const valueEnd = i;
    i += quote.length;

    let partStart = valueStart;
    let first = true;
    for (let j = valueStart; j <= valueEnd; j++) {
      if (j === valueEnd || body[j] === ',') {
        push(first ? 'structTagName' : 'structTagOption', partStart, j);
        first = false;
        partStart = j + 1;
      }
    }
  }
}

function markerSpans(comment: Node, marker: MarkerParts, spans: Span[]): void {
  const base = comment.startPosition;
  const push = (kind: SpanKind, [from, to]: Range) => {
    const at = (offset: number): Point => ({ row: base.row, column: base.column + offset });
    if (to > from) spans.push({ kind, start: at(from), end: at(to) });
  };
  push('markerPrefix', [marker.prefix, marker.prefix + 1]);
  push('markerName', marker.name);
  for (const arg of marker.arguments) {
    if (arg.key) push('markerArgument', arg.key);
    push('markerValue', arg.value);
  }
}

// [from, to) offsets into a comment's text.
export type Range = [number, number];

export interface MarkerParts {
  // Offset of the `+`.
  prefix: number;
  name: Range;
  // The text of `name`, e.g. kubebuilder:validation:Minimum.
  nameText: string;
  // In source order. The anonymous value of `+name=value` has no key.
  arguments: Array<{ key?: Range; keyText?: string; value: Range }>;
}

// Splits a one-line `// +marker...` comment; null if it is not one. Shared by highlighting and
// hover so that both agree on what is the name and what an argument.
//
// controller-gen marker syntax: +path:to:name, +path:to:name=value, or +path:to:name:k=v,k2=v2.
// Lexically, `+a:b:c=1` (marker a:b:c, anonymous value) and `+a:b:c=1` (marker a:b, argument c)
// look the same; the registry tells them apart. For a marker it does not know, the last path
// segment is read as an argument key only when two or more key=value pairs follow, which covers
// printcolumn and rbac style markers from generators the registry was not built from.
export function parseMarker(text: string, registry?: MarkerRegistry): MarkerParts | null {
  if (!MARKER.test(text) || BUILD_CONSTRAINT.test(text) || text.includes('\n')) return null;
  const prefix = text.indexOf('+');
  const nameStart = prefix + 1;
  let end = text.length;
  while (end > nameStart && /\s/.test(text[end - 1]!)) end--;

  const eq = text.indexOf('=', nameStart);
  if (eq < 0 || eq >= end) {
    return { prefix, name: [nameStart, end], nameText: text.slice(nameStart, end), arguments: [] };
  }

  const pieces = splitTopLevel(text, eq + 1, end);
  let nameEnd = eq;
  let firstKeyStart = -1;
  const known = registry?.nameLength(text.slice(nameStart, end));
  if (known != null) {
    nameEnd = nameStart + known;
    if (nameEnd < eq) firstKeyStart = nameEnd + 1;
  } else if (pieces.length >= 2 && pieces.slice(1).every((a) => keyOf(text, a) !== null)) {
    const colon = text.lastIndexOf(':', eq);
    if (colon > nameStart) {
      nameEnd = colon;
      firstKeyStart = colon + 1;
    }
  }

  const args: MarkerParts['arguments'] = [];
  const first: Range = [eq + 1, pieces[0]![1]];
  if (firstKeyStart >= 0) {
    args.push({ key: [firstKeyStart, eq], keyText: text.slice(firstKeyStart, eq), value: first });
  } else {
    args.push({ value: first });
  }
  for (const piece of pieces.slice(1)) {
    const keyEnd = keyOf(text, piece);
    if (keyEnd === null) {
      args.push({ value: piece });
    } else {
      const key: Range = [piece[0], keyEnd];
      args.push({ key, keyText: text.slice(...key), value: [keyEnd + 1, piece[1]] });
    }
  }
  const nameText = text.slice(nameStart, nameEnd);
  return { prefix, name: [nameStart, nameEnd], nameText, arguments: args };
}

// Comma-separated pieces of text[from, to), ignoring commas inside quotes, backticks or braces.
function splitTopLevel(text: string, from: number, to: number): Range[] {
  const pieces: Range[] = [];
  let start = from;
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < to; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === ',' && depth === 0) {
      pieces.push([start, i]);
      start = i + 1;
    }
  }
  pieces.push([start, to]);
  return pieces;
}

// Index of the `=` if the piece is `identifier=...`, else null.
function keyOf(text: string, [from, to]: Range): number | null {
  const match = /^[A-Za-z_][\w.-]*=/.exec(text.slice(from, to));
  return match ? from + match[0].length - 1 : null;
}
