// Turns a tree-sitter-go syntax tree into highlight spans. Pure: no vscode import, so it runs under
// `node --test` against the real parser.
//
// Positions are tree-sitter Points. web-tree-sitter measures columns in UTF-16 code units, the same
// unit as a vscode.Position character, so they map across without conversion.
import type { Node, Point } from 'web-tree-sitter';

export type { Point };
import type { MarkerRegistry, MarkerTarget } from './markers.ts';

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

// A doc comment of an exported declaration that does not start with its name.
export interface DocIssue {
  // The word the doc starts with instead.
  start: Point;
  end: Point;
  word: string;
  // Every name the doc may start with: the Go names, and a field's json name.
  names: string[];
  // Quick fixes, each replacing `word` with `text`: the name itself when `word` is that name in
  // the wrong case, otherwise the name followed by `word`, since a doc that opens with a verb
  // ("defines the ...") only lacks its subject. Go names come first.
  fixes: Array<{ name: string; text: string }>;
}

export interface Analysis {
  spans: Span[];
  docIssues: DocIssue[];
  // Every marker comment, with what controller-gen attaches it to.
  markers: MarkerSite[];
  // Comment row -> what a marker on that row may attach to, in order of preference; absent where
  // controller-gen does not read markers.
  targets: Map<number, MarkerTarget[]>;
}

export interface MarkerSite {
  // Where the comment starts; MarkerParts offsets are relative to it.
  start: Point;
  parts: MarkerParts;
  // What the marker may attach to, in order of preference; empty where controller-gen ignores it.
  targets: MarkerTarget[];
}

export interface AnalyzeOptions {
  structTags: boolean;
  docComments: boolean;
  markers: boolean;
  // Report doc comments that do not start with their declaration's name.
  docStart?: boolean;
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

export function analyze(root: Node, options: AnalyzeOptions): Analysis {
  const spans: Span[] = [];
  const docIssues: DocIssue[] = [];
  const markers: MarkerSite[] = [];
  const targets = markerTargets(root);
  // Doc comment id -> the names it may mention.
  const docComments = new Map<number, string[]>();

  walk(root, (node) => {
    if ((options.docComments || options.docStart) && DOCUMENTED.has(node.type)) {
      const goNames = declaredNames(node);
      // Kubernetes API conventions (kube-api-linter's commentstart) start a field's doc with its
      // serialized name instead, since the doc becomes the CRD's OpenAPI description. Both count.
      const json = node.type === 'field_declaration' ? jsonName(node) : undefined;
      const names = json && !goNames.includes(json) ? [...goNames, json] : goNames;
      const group = docCommentGroup(node);
      if (options.docComments && names.length > 0) {
        for (const comment of group) docComments.set(comment.id, names);
      }
      // As golint/revive: only exported declarations, and the package clause is out of scope.
      if (options.docStart && node.type !== 'package_clause' && goNames.some(isExported)) {
        const issue = docStartIssue(group, names);
        if (issue) docIssues.push(issue);
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
        const at = targets.get(node.startPosition.row) ?? [];
        markers.push({ start: node.startPosition, parts: marker, targets: at });
      } else if (docComments.has(node.id) && !DIRECTIVE.test(node.text)) {
        docNameSpans(node, docComments.get(node.id)!, spans);
      }
    }
  });
  return { spans, docIssues, markers, targets };
}

// What controller-gen attaches each comment's markers to, mirroring controller-tools
// pkg/markers/collect.go. Before each declaration it reads two comment groups: the doc comment
// (the group ending on the line above) and the closest group before that, separated by a blank
// line. A field takes both. A type takes both too, but a marker in the closest group that is a
// package marker and not a type marker goes to the package -- that is how the +kubebuilder:webhook
// line Kubebuilder scaffolds above a defaulter type works. A top-level declaration of any other
// kind hands the closest group to the package and drops its doc, so markers inside a function's
// doc comment are ignored. Other groups at top level, those above `package` and those after the
// last declaration belong to the package. Trailing comments and comments anywhere else (function
// bodies, a third group above a field) are ignored.
//
// Each comment row maps to the targets to try, in order; a row that is absent is ignored.
function markerTargets(root: Node): Map<number, MarkerTarget[]> {
  const targets = new Map<number, MarkerTarget[]>();
  const assign = (groups: Node[][], to: MarkerTarget[]) => {
    for (const group of groups) for (const c of group) targets.set(c.startPosition.row, to);
  };
  const isGroup = (node: Node) => node.children.some((c) => c.type === '(');

  // `kind` says how a non-comment child takes its doc and closest groups; other groups before
  // it go to `rest`. Returns the comments left after the last child.
  const scan = (
    parent: Node,
    kind: (node: Node) => { doc: MarkerTarget[]; closest: MarkerTarget[] } | null,
    rest: MarkerTarget[],
  ): Node[] => {
    let pending: Node[] = [];
    let previous: Node | null = null;
    for (const child of parent.children) {
      if (child.type === 'comment') {
        // A comment on the line where the previous code ends is that code's trailing comment.
        if (previous?.endPosition.row !== child.startPosition.row) pending.push(child);
        continue;
      }
      const how = kind(child);
      if (how) {
        const groups = commentGroups(pending);
        const last = groups.at(-1);
        const adjacent = last && last.at(-1)!.endPosition.row === child.startPosition.row - 1;
        const doc = adjacent ? last : undefined;
        const before = doc ? groups.slice(0, -1) : groups;
        const closest = before.at(-1);
        if (doc) assign([doc], how.doc);
        if (closest) assign([closest], how.closest);
        assign(before.slice(0, -1), rest);
      }
      pending = [];
      previous = child;
    }
    return pending;
  };

  const TYPE = { doc: ['type'], closest: ['type', 'package'] } satisfies Record<
    string,
    MarkerTarget[]
  >;
  const FIELD = { doc: ['field'], closest: ['field'] } satisfies Record<string, MarkerTarget[]>;
  const trailing = scan(
    root,
    (node) => {
      if (node.type === 'package_clause') return { doc: ['package'], closest: ['package'] };
      if (node.type === 'type_declaration' && !isGroup(node)) return TYPE;
      return { doc: [], closest: ['package'] };
    },
    ['package'],
  );
  assign(commentGroups(trailing), ['package']);
  walk(root, (node) => {
    if (node.type === 'type_declaration' && isGroup(node)) {
      scan(node, (c) => (c.type === 'type_spec' || c.type === 'type_alias' ? TYPE : null), []);
    } else if (node.type === 'field_declaration_list' || node.type === 'interface_type') {
      scan(node, (c) => (c.type === '{' || c.type === '}' ? null : FIELD), []);
    }
  });
  return targets;
}

// go/ast comment groups: comments on consecutive lines, no blank line between.
function commentGroups(comments: Node[]): Node[][] {
  const groups: Node[][] = [];
  for (const c of comments) {
    const group = groups.at(-1);
    if (group && group.at(-1)!.endPosition.row === c.startPosition.row - 1) group.push(c);
    else groups.push([c]);
  }
  return groups;
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

function isExported(name: string): boolean {
  return /^\p{Lu}/u.test(name);
}

// The name in a field's json tag, if it has one: `spec` in json:"spec,omitempty".
function jsonName(field: Node): string | undefined {
  const tag = field.childForFieldName('tag');
  if (!tag) return undefined;
  const body = tag.text.slice(1, -1);
  const text = tag.type === 'raw_string_literal' ? body : body.replace(/\\"/g, '"');
  const name = /(?:^|\s)json:"([^",]*)/.exec(text)?.[1];
  return name && name !== '-' ? name : undefined;
}

// Go doc comments may open with an article: "A Foo is ...".
const ARTICLES = new Set(['A', 'An', 'The']);
const LEADING_WORD = /^(\/\/|\/\*)[ \t]*([\p{L}\p{N}_]+)(?:[ \t]+([\p{L}\p{N}_]+))?/u;

// The first prose line of the group (markers and directives are not prose) must start with one of
// the names. A doc that starts with no word at all, or with text on a later line of a block
// comment, is left alone.
function docStartIssue(group: Node[], names: string[]): DocIssue | null {
  const first = [...group]
    .reverse()
    .find((c) => !DIRECTIVE.test(c.text) && parseMarker(c.text) === null);
  if (!first) return null;
  const match = LEADING_WORD.exec(first.text);
  if (!match) return null;
  const article = ARTICLES.has(match[2]!) && match[3] !== undefined;
  const word = article ? match[3]! : match[2]!;
  // Both words end their part of the match, so each is found from the end.
  const offset = article ? match[0].length - word.length : match[0].indexOf(word, 2);
  if (names.includes(word)) return null;
  const { row, column } = first.startPosition;
  return {
    start: { row, column: column + offset },
    end: { row, column: column + offset + word.length },
    word,
    names,
    fixes: fixesFor(word, names),
  };
}

function fixesFor(word: string, names: string[]): DocIssue['fixes'] {
  const recased = names.filter((n) => n.toLowerCase() === word.toLowerCase());
  if (recased.length > 0) return recased.map((name) => ({ name, text: name }));
  return names.map((name) => ({ name, text: `${name} ${word}` }));
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
  // The comment text the offsets point into.
  text: string;
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
    const nameText = text.slice(nameStart, end);
    return { text, prefix, name: [nameStart, end], nameText, arguments: [] };
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
  return { text, prefix, name: [nameStart, nameEnd], nameText, arguments: args };
}

// Comma-separated pieces of text[from, to), ignoring commas inside quotes, backticks or braces.
export function splitTopLevel(text: string, from: number, to: number): Range[] {
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
export function keyOf(text: string, [from, to]: Range): number | null {
  const match = /^[A-Za-z_][\w.-]*=/.exec(text.slice(from, to));
  return match ? from + match[0].length - 1 : null;
}
