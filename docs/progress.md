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
  text), a smoke test over a real Kubebuilder project's API types, and a bundle test that `require()`s
  `dist/extension.cjs` with a stub `vscode` and activates it. `npm run check` passes.
- Bug the bundle test caught: web-tree-sitter's ESM build calls `createRequire(import.meta.url)`,
  undefined in a CommonJS bundle. Fixed with an esbuild `banner` + `define` in `scripts/build.mjs`.

Not yet verified:

- **Never run inside a real VS Code window.** Everything above is tested in Node only. First thing
  to do: F5, open a Kubebuilder `*_types.go`, and check the colours appear over
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
- Tests: registry parsing and splitting, a live comparison of a real controller-gen's
  output with the built-in copy, and bundle tests for both the untrusted (built-in) and trusted
  (`bin/controller-gen`, cached) paths. `npm run check` passes.
- On the Kubebuilder project used for trying it out, the registry changes no spans: they have no single-argument
  struct markers. The visible difference is in projects using `resource:scope=` and the like.

Not yet verified:

- Still never run in a real VS Code window (see phase 1). Add to that check: the *Go Annotations*
  output channel should say `Using N markers from .../bin/controller-gen (v0.19.0)`.

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
- Zero warnings over a real Kubebuilder project's Go files.
- The owner checked the warning and both kinds of quick fix in VS Code.

## 2026-10-30 — phase 6: marker completion and diagnostics

Done (see [design.md](design.md#where-a-marker-attaches)):

- `markerTargets()` in the analyzer: where controller-gen attaches each comment's markers, read
  from its source and checked by running controller-gen on probe files. Found on the way: markers
  in a function's doc are ignored; a package marker in the group above a type moves to the
  package; a third group above a field is ignored.
- `src/markerDiagnostics.ts` with controller-gen's severities and did-you-mean quick fixes;
  `src/markerCompletion.ts`. Setting `goAnnotations.markers.diagnostics`.
- Registry now includes the `applyconfiguration` generator (`kubebuilder:ac:*`), deduplicates
  markers shared between generators; the globalState cache key moved to `controllerGenHelp/v2/`.
- Zero diagnostics over a real Kubebuilder project's 52 markers. `test/fixtures/sample.go` has a real one:
  its `+kubebuilder:rbac` sits in a type's doc, which controller-gen ignores.
- Code formatted with prettier (`--print-width 100 --single-quote`) where new; there is no
  prettier config or dependency in the repo yet.

The owner checked completion, diagnostics and quick fixes in VS Code.

## 2026-10-30 — phase 7: separating marker arguments

Italics alone did not separate the arguments of a long marker. Each `key=value` of a marker with
named arguments now sits on a faint hueless rounded block (`goAnnotations.markerArgumentPair`),
painted on the inline span via `textDecoration` so blocks on consecutive lines do not touch. The
owner checked it in VS Code.

## 2026-10-30 — phase 8: publishable

- `package.json`: publisher `chihayaanon`, version 0.1.0, MIT, repository/bugs/homepage on
  `github.com/tihaya-anon/vscode-go-annotations`, icon, keywords, categories (Programming
  Languages, Linters). "Go Annotations" is not taken as a Marketplace display name (checked).
- `LICENSE`, `CHANGELOG.md` (0.1.0 Unreleased), Marketplace-oriented README, icon (`//+` in grey strokes on
  transparent, in the style of the MCP Config Manager icon) from
  `resources/brand.svg`, `.vscodeignore`, production build (minified, no source maps).
- `npm run package` gives a 171 KB `.vsix` of 8 files; the bundle tests pass on the minified build.

Not done, needs the owner: the GitHub repository does not exist yet (README links and the
Marketplace "Repository" link point at it); screenshots for the README; `vsce publish` with the
owner's token.

## 2026-10-30 — phase 9: no playground

The repository goes public, so the playground (a clone of the owner's private Kubebuilder project,
and the script that made it) is gone. The live controller-gen tests use `bin/controller-gen`
(gitignored, `go install`ed, see AGENTS.md); the smoke test runs over `test/fixtures/`; F5 opens
`test/fixtures/`.

## Next steps

1. Publish 0.1.0: the repo is pushed and `v0.1.0` tagged; `.github/workflows/publish.yml` publishes
   with Trusted Publishing once the owner has created the policy on the Marketplace publisher
   page. The tag predates the workflow, so 0.1.0 goes out by a manual run on `main`
   (`gh workflow run publish.yml`). Optionally add README screenshots.
2. Possibly: value completion (bool, enums such as `scope=Cluster|Namespaced` are not in the
   help, so only bool), checking string values, a prettier config.
3. Only if large files feel slow: incremental parsing with `tree.edit()` from
   `TextDocumentChangeEvent.contentChanges`.
