# Progress

## 2026-10-30 — phase 1: highlighting (option B)

Done:

- Repository scaffolded: ESM TypeScript, esbuild bundle to `dist/extension.cjs`, `node --test`.
- `src/analyze.ts`: struct tags, doc comments, markers, with the rules in
  [design.md](design.md#analyzer-rules).
- `src/extension.ts`: eight decoration types bound to contributed theme colours, 100 ms debounce
  per document, cache keyed by document version, settings to switch each feature off and to
  choose doc-comment font style.
- Tests: analyzer cases over `test/fixtures/sample.go` (including UTF-16 column checks with Chinese
  text), a smoke test over `playground/api/v1alpha1`, and a bundle test that `require()`s
  `dist/extension.cjs` with a stub `vscode` and activates it. `npm run check` passes.
- Bug the bundle test caught: web-tree-sitter's ESM build calls `createRequire(import.meta.url)`,
  undefined in a CommonJS bundle. Fixed with an esbuild `banner` + `define` in `scripts/build.mjs`.

Not yet verified:

- **Never run inside a real VS Code window.** Everything above is tested in Node only. First thing
  to do: F5, open `playground/api/v1alpha1/dataset_types.go`, and check the colours appear over
  gopls semantic highlighting, survive edits, and follow light/dark theme switches.
- Default colours are a first guess (GoLand Darcula-like for docs and markers); tune them by eye.

## 2026-10-30 — phase 2: marker registry

Done:

- `src/markers.ts`: `MarkerRegistry` parsed from `controller-gen <gen> -wwww` JSON (not the `-ww`
  text), keeping targets, arguments, optionality, slice item types and `deprecatedInFavorOf`.
  `nameLength()` mirrors controller-tools' `splitMarker` + `tryAnonLookup`.
- Analyzer uses it: `+kubebuilder:resource:scope=Cluster` now shows `scope` as an argument. Unknown
  markers keep the old lexical guess.
- Built-in registry `src/controller-gen-markers.json` (v0.19.0, `scripts/capture-markers.sh`);
  in a trusted workspace the extension switches to the project's own controller-gen, cached per
  version in `globalState`. Setting `goAnnotations.markers.controllerGenPath`; untrusted
  workspaces are declared `limited` and never run it. See
  [design.md](design.md#marker-registry).
- Fixed: `// +build ...` build constraints were highlighted as markers.
- Tests: registry parsing and splitting, a live comparison of `playground/bin/controller-gen`
  output with the built-in copy, and bundle tests for both the untrusted (built-in) and trusted
  (`bin/controller-gen`, cached) paths. `npm run check` passes.
- On the playground's own API types the registry changes no spans: they have no single-argument
  struct markers. The visible difference is in projects using `resource:scope=` and the like.

Not yet verified:

- Still never run in a real VS Code window (see phase 1). Add to that check: the *Go Annotations*
  output channel should say `Using N markers from .../playground/bin/controller-gen (v0.19.0)`.

## 2026-10-30 — phase 3: first look in VS Code

The owner ran it (F5) and found it working. Their feedback and what changed:

- Output channel not found: added command *Go Annotations: Show Log*. The channel lives in the
  Extension Development Host window, not the window F5 was pressed in. Not re-checked.
- Too many extensions in the dev host: `.vscode/launch.json` disables everything installed on the
  owner's machine except themes, icons and remote-wsl. golang.go is **not installed** in their
  WSL server, so gopls semantic tokens were not in play in that first look; install it there to
  check decorations over gopls as the design intends.
- Doc comments: only the documented name is highlighted (bold), not the whole comment.
- Colours too loud for comments: doc names and markers keep the comment colour and use bold /
  italic; `goAnnotations.comments.useColors` restores colours. Struct tags still coloured —
  ask the owner whether those should be toned down too.

The owner accepted these styles, struct tag colours included (committed as d1c847c).

## 2026-10-30 — phase 4: marker hover

Done:

- `parseMarker()` in `src/analyze.ts`: marker splitting as a structure (offsets of `+`, name,
  each argument's key and value), used by both highlighting and hover.
- `src/markerHover.ts`: markdown for the marker or the argument under the cursor; a summary that
  controller-gen cut mid-sentence is rejoined with its details. Registered as a `go` hover
  provider using whichever registry is loaded. Tests in `test/markerHover.test.ts` and through the
  bundle stub.

Not yet verified: how the hover looks in VS Code next to gopls's own hover.

The owner liked the hover; titles are now bold with italic qualifiers (committed as eb9ad26).

## 2026-10-30 — phase 5: doc start check

Prompted by `// spec defines ...` on `Dataset.Spec` not being emboldened. That lowercase start is
deliberate Kubernetes convention, so (owner's choice) json names now count as the documented
name, and the check warns only when a doc opens with neither name:

- `analyze()` returns `{ spans, docIssues }`; `docStart` option; json names highlighted.
- Warning `doc-start`; quick fixes replace a wrong-case name, or else insert the name in front
  (after the owner tried it on a verb-first doc). Setting `goAnnotations.docComments.checkStart`.
- Zero warnings over the playground's Go files.
- The owner checked the warning and both kinds of quick fix in VS Code.

## Next steps

1. Completion after `// +` and after `marker:`; diagnostics (unknown marker within covered
   namespaces, missing required argument, wrong target, deprecated) — see
   [design.md](design.md#marker-registry) for the scaffold-marker caveat. Wrong-target needs the
   attachment target (package/type/field) from the syntax tree, which hover does not use yet.
2. Only if large files feel slow: incremental parsing with `tree.edit()` from
   `TextDocumentChangeEvent.contentChanges`.
3. Decide a licence (package.json says `UNLICENSED` for now) and whether to publish.
