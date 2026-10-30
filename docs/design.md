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
- A decoration cannot take its colour from the theme's comment token colour (or derive a
  bolder/more saturated variant of it), and a contributed colour must have a default. So
  decorations inside comments (doc names, markers) set no colour by default and differ by weight
  and style only: names bold, marker arguments italic. The owner's verdict on coloured comment
  parts was that they read as code. `goAnnotations.comments.useColors` brings the colours back.
  Struct tags are code and keep colours. A future option is reading the active theme's JSON for
  the comment colour and deriving variants from it; fragile (theme includes, semantic overrides).
- The whole document is reparsed on each (debounced) change. Fine for normal files; incremental
  parsing with `tree.edit()` is a later optimisation if profiling asks for it.

## Analyzer rules

- **Doc comment**: the comment lines directly above a declaration (`DOCUMENTED` in
  `src/analyze.ts`) with no blank line between, stopping at a comment that shares its first line
  with earlier code (that is a trailing comment). Directive lines (go/doc's
  `^//(line |extern |export |[a-z0-9]+:[a-z0-9])`) are excluded, matching what go/doc drops.
  Only the declared name is highlighted, wherever it appears in the group as a whole,
  case-sensitive word (`NotX` does not match field `X`). The name is the spec's for a single
  `type`/`const`/`var` declaration, every name for `X, Y int`, the type's for an embedded field
  (`*pkg.T[int]` -> `T`); a parenthesised group's own doc has no name.
- **Struct tag**: `reflect.StructTag` syntax, `key:"value"` pairs; the value split on `,` into a
  name and options (encoding/json convention). Raw and interpreted (`"json:\"x\""`) tags both work;
  multi-line tags are skipped.
- **Marker**: a line comment `// +name...` where a name character follows `+`. Marker lines are
  markers even inside a doc group, so spans never overlap. `// +build ...` (the pre-1.17 build
  constraint) has the marker shape and is excluded.

### Marker name vs argument

controller-gen syntax `+a:b:c=1` is either marker `a:b:c` with an anonymous value or marker `a:b`
with named argument `c`. Lexically they are identical. With the registry the analyzer does what
controller-tools does (`splitMarker` + `tryAnonLookup` in `pkg/markers`): look up everything before
the first `=`, and if that is not a marker, drop the last `:`-segment and look that up. The target
(package/type/field) is ignored for the split. A marker the registry does not know (Kubebuilder's
`+kubebuilder:scaffold:*`, other generators) falls back to a lexical guess: the last segment is an
argument key only when two or more `key=value` arguments follow (printcolumn, rbac style).

## Marker registry

controller-gen describes every marker it knows, with its target and arguments:

```text
$ bin/controller-gen crd -ww
+kubebuilder:printcolumn type
	adds a column to "kubectl get" output for this CRD.
	JSONPath=<string>       specifies the jsonpath expression ...
	[priority=<int>]        indicates how important ...
```

`-wwww` prints the same as JSON (one array of categories per generator), which is what is parsed;
the text form is never scraped. `rbac` refuses to print help without `rbac:roleName=<any>`.
Marker order in the output varies between runs because controller-gen walks Go maps.

Where the registry comes from:

1. `src/controller-gen-markers.json`, captured from v0.19.0 by `scripts/capture-markers.sh` and
   bundled, so highlighting is exact from the first paint and without controller-gen installed.
2. Once activated, and only in a trusted workspace (running a workspace binary is code
   execution), the first controller-gen that answers `--version` among
   `goAnnotations.markers.controllerGenPath`, `<folder>/bin/controller-gen` and `PATH`. Its help
   for `crd`, `rbac`, `webhook` and `object` is cached in `globalState` per release version
   (`(devel)` builds are not cached), and replaces the built-in set. It is reloaded when
   `bin/controller-gen*` appears or changes, when trust is granted, or when the setting changes.

Uses:

- exact name/argument splitting for highlighting (done);
- hover documentation (done): over `+` and the name, the marker (title in bold and its
  qualifiers in italics rather than a hard-coded colour; targets sharing a description merged;
  its arguments in `-ww` notation); over an argument's key or value, that argument. Only
  whole-line `//` comments, which is where controller-gen reads markers. Highlighting and hover
  share `parseMarker()` so they never disagree on where the name ends;
- completion after `// +`;
- diagnostics: unknown marker, missing required argument, wrong target (a `type` marker on a
  field), using the syntax tree the analyzer already has. `+kubebuilder:scaffold:*` (Kubebuilder
  CLI insertion points) and other generators' markers are not in the registry, so "unknown" must
  be limited to the namespaces the registry covers (`kubebuilder:validation:*` etc.).

`extensionKind: ["workspace"]` is set so that, in a dev container, the extension runs where
`controller-gen` is.
