# Design

## Goal

JetBrains GoLand colours struct tags, doc comments and framework annotations distinctly. VS Code
with the official Go extension does not: struct tags are one string colour and every comment is one
comment colour. This extension adds those distinctions for Go, with Kubebuilder projects as the
primary target.

## Prior art (surveyed 2026-10-30)

- [Go Struct Tags Manager](https://marketplace.visualstudio.com/items?itemName=woozy-masta.go-struct-tags-manager)
  ([source](https://github.com/WoozyMasta/go-struct-tags-manager)): TextMate grammar injection into
  Go raw strings for tag colouring, plus tag sort/align and struct layout analysis.
- [Go Struct Tag Highlighter](https://marketplace.visualstudio.com/items?itemName=fernandomf.go-struct-tag-highlighter):
  tag keys and values only.
- Nothing found for distinct doc-comment colouring or for Kubebuilder / controller-gen markers.

## The constraint that decides the mechanism

gopls semantic tokens (`"gopls": {"ui.semanticTokens": true}`, which the owner uses) cover these
same ranges. In gopls `internal/golang/semtok.go` (checked at v0.21.1 and v0.23.0):

- a struct tag is an `*ast.BasicLit` and is emitted as one `string` token;
- a comment is emitted as one `comment` token, except that doc links (`[Foo]`) and `//go:`
  directives are split out.

VS Code paints a semantic token's style over its whole range, so any finer TextMate scopes injected
inside a tag or comment are flattened back to one colour. A TextMate approach only works with
`"gopls": {"semanticTokenTypes": {"string": false, "comment": false}}`, which also loses gopls's
doc-link, directive and format-verb colouring. (Reasoned from the gopls source and VS Code's
documented precedence; confirm with "Developer: Inspect Editor Tokens and Scopes" if it matters.)

## Options considered

| Option | Mechanism | Verdict |
| --- | --- | --- |
| A. TextMate injection | Declarative grammar matching inside `string.quoted.raw.go` / `comment` scopes | Rejected: needs gopls string/comment tokens off, and a line-based grammar cannot tell a doc comment (needs to see the next line's declaration) from any other comment |
| B. Decorations + tree-sitter | Parse with web-tree-sitter + tree-sitter-go in the extension host, paint `TextEditorDecorationType`s | **Chosen** |
| C. Upstream gopls change | New semantic token types/modifiers for tags and doc comments | Long-term only; gopls's own doc already wonders whether tags should be `property` tokens |

B wins because doc comments need the syntax tree anyway, and once the tree is there, tags and
markers come almost free. Decorations render above both TextMate and semantic tokens, so gopls
semantic highlighting stays fully on.

Costs accepted with B:

- Colours are contributed theme colours with light/dark/high-contrast defaults rather than theme
  scopes; themes do not know about them, users override via `workbench.colorCustomizations`.
- Font style cannot come from a theme colour, so doc-comment italics is a setting.
- The whole document is reparsed on each (debounced) change. Fine for normal files; incremental
  parsing with `tree.edit()` is a later optimisation if profiling asks for it.

## Analyzer rules

- **Doc comment**: the comment lines directly above a declaration (`DOCUMENTED` in
  `src/analyze.ts`) with no blank line between, stopping at a comment that shares its first line
  with earlier code (that is a trailing comment). Directive lines (go/doc's
  `^//(line |extern |export |[a-z0-9]+:[a-z0-9])`) are excluded, matching what go/doc drops.
- **Struct tag**: `reflect.StructTag` syntax, `key:"value"` pairs; the value split on `,` into a
  name and options (encoding/json convention). Raw and interpreted (`"json:\"x\""`) tags both work;
  multi-line tags are skipped.
- **Marker**: a line comment `// +name...` where a name character follows `+`. Marker lines are
  markers even inside a doc group, so spans never overlap.

### Known limitation: marker name vs argument

controller-gen syntax `+a:b:c=1` is either marker `a:b:c` with an anonymous value or marker `a:b`
with named argument `c`. Lexically they are identical. The analyzer currently treats the last path
segment as an argument key only when two or more `key=value` arguments follow (printcolumn, rbac).
`+kubebuilder:resource:scope=Cluster` therefore shows `scope` as part of the name. The marker
registry (next phase) resolves this properly.

## Next phase: marker registry

controller-gen describes every marker it knows, with its target and arguments:

```text
$ bin/controller-gen crd -ww
+kubebuilder:printcolumn type
	adds a column to "kubectl get" output for this CRD.
	JSONPath=<string>       specifies the jsonpath expression ...
	[priority=<int>]        indicates how important ...
```

Parsing that output for the `crd`, `rbac`, `webhook` and `object` generators (cached per
controller-gen version) gives:

- exact name/argument splitting for highlighting;
- hover documentation;
- completion after `// +`;
- diagnostics: unknown marker, missing required argument, wrong target (a `type` marker on a
  field), using the syntax tree the analyzer already has.

`extensionKind: ["workspace"]` is set so that, in a dev container, the extension runs where
`controller-gen` is.
