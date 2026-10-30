// Turns a tree-sitter-go syntax tree into highlight spans. Pure: no vscode import, so it runs under
// `node --test` against the real parser.
//
// Positions are tree-sitter Points. web-tree-sitter measures columns in UTF-16 code units, the same
// unit as a vscode.Position character, so they map across without conversion.
import type { Node, Point } from 'web-tree-sitter';

export type SpanKind =
  | 'structTagKey'
  | 'structTagName'
  | 'structTagOption'
  | 'docComment'
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

export function analyze(root: Node, options: AnalyzeOptions): Span[] {
  const spans: Span[] = [];
  const docComments = new Set<number>();

  walk(root, (node) => {
    if (options.docComments && DOCUMENTED.has(node.type)) {
      for (const comment of docCommentGroup(node)) docComments.add(comment.id);
    }
    if (options.structTags && node.type === 'field_declaration') {
      const tag = node.childForFieldName('tag');
      if (tag) structTagSpans(tag, spans);
    }
    if (node.type === 'comment') {
      if (options.markers && MARKER.test(node.text)) {
        markerSpans(node, spans);
      } else if (docComments.has(node.id) && !DIRECTIVE.test(node.text)) {
        spans.push({ kind: 'docComment', start: node.startPosition, end: node.endPosition });
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

// controller-gen marker syntax: +path:to:name, +path:to:name=value, or +path:to:name:k=v,k2=v2.
// Lexically, `+a:b:c=1` (anonymous value) and `+a:b:c=1` (named arg c) look the same; only the
// marker registry can tell them apart. Without it, the last path segment is read as an argument
// key only when two or more key=value pairs follow, which covers printcolumn and rbac.
function markerSpans(comment: Node, spans: Span[]): void {
  const text = comment.text;
  if (text.includes('\n')) return;
  const base = comment.startPosition;
  const at = (offset: number): Point => ({ row: base.row, column: base.column + offset });
  const push = (kind: SpanKind, from: number, to: number) => {
    if (to > from) spans.push({ kind, start: at(from), end: at(to) });
  };

  const plus = text.indexOf('+');
  push('markerPrefix', plus, plus + 1);
  const nameStart = plus + 1;
  let end = text.length;
  while (end > nameStart && /\s/.test(text[end - 1]!)) end--;

  const eq = text.indexOf('=', nameStart);
  if (eq < 0 || eq >= end) {
    push('markerName', nameStart, end);
    return;
  }

  const args = splitTopLevel(text, eq + 1, end);
  let nameEnd = eq;
  let firstKeyStart = -1;
  if (args.length >= 2 && args.slice(1).every((a) => keyOf(text, a) !== null)) {
    const colon = text.lastIndexOf(':', eq);
    if (colon > nameStart) {
      nameEnd = colon;
      firstKeyStart = colon + 1;
    }
  }
  push('markerName', nameStart, nameEnd);

  if (firstKeyStart >= 0) push('markerArgument', firstKeyStart, eq);
  push('markerValue', eq + 1, args[0]![1]);
  for (const arg of args.slice(1)) {
    const keyEnd = keyOf(text, arg);
    if (keyEnd === null) {
      push('markerValue', arg[0], arg[1]);
      continue;
    }
    push('markerArgument', arg[0], keyEnd);
    push('markerValue', keyEnd + 1, arg[1]);
  }
}

// Comma-separated pieces of text[from, to), ignoring commas inside quotes, backticks or braces.
function splitTopLevel(text: string, from: number, to: number): Array<[number, number]> {
  const pieces: Array<[number, number]> = [];
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
function keyOf(text: string, [from, to]: [number, number]): number | null {
  const match = /^[A-Za-z_][\w.-]*=/.exec(text.slice(from, to));
  return match ? from + match[0].length - 1 : null;
}
