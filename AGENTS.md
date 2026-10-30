# Agent guidance

`AGENTS.md` is the source of truth; `CLAUDE.md` is a gitignored copy for Claude. Edit `AGENTS.md`,
then `cp AGENTS.md CLAUDE.md`.

## What this is

A VS Code extension that adds JetBrains-style highlighting to Go on top of the official Go extension:

- struct tags split into key / name / options (`json:"name,omitempty"`);
- doc comments of declarations, struct fields and interface methods, distinct from other comments;
- controller-gen / Kubebuilder markers (`// +kubebuilder:validation:Minimum=1`).

Read [docs/design.md](docs/design.md)
for why it is built this way and [docs/progress.md](docs/progress.md) for where it stands and what
comes next — start there when picking the work up.

The owner is an experienced backend engineer; replies to them are in Chinese (中文). Code, comments
and docs in this repository are in English.

## Layout

```text
src/analyze.ts        pure: tree-sitter syntax tree -> highlight spans (no vscode import)
src/goParser.ts       loads web-tree-sitter and the Go grammar .wasm
src/markers.ts        pure: marker registry parsed from `controller-gen <gen> -wwww` JSON
src/markerHover.ts    pure: hover markdown for the marker or argument under the cursor
src/markerCompletion.ts   pure: marker name and argument completion
src/markerDiagnostics.ts  pure: marker checks with controller-gen's severities
src/controllerGen.ts  runs a controller-gen binary for its version and marker help
src/controller-gen-markers.json  built-in registry, used until/unless a workspace one loads
src/extension.ts      vscode glue: decoration types, debounce, per-document cache, registry loading
test/analyze.test.ts  analyzer against test/fixtures/sample.go and markers.go
test/markers.test.ts  registry parsing and name splitting; live check against bin/controller-gen
test/markerHover.test.ts  hover text against the built-in registry
test/markerCompletion.test.ts, test/markerDiagnostics.test.ts  likewise
test/bundle.test.ts   require()s dist/extension.cjs with a stub vscode module and activates it
scripts/build.mjs     esbuild bundle + copies both .wasm files into dist/
scripts/capture-markers.sh  regenerates src/controller-gen-markers.json from a controller-gen
scripts/make-icon.mjs resources/brand.svg -> resources/icon.png (npm run icon; PNG is committed)
.vscodeignore         allow-list of what goes into the .vsix
bin/                  controller-gen for the live tests (gitignored, installed by hand)
```

## Commands

```bash
npm install
# Optional: controller-gen in bin/, as Kubebuilder projects keep it, for the live tests
GOBIN=$PWD/bin go install sigs.k8s.io/controller-tools/cmd/controller-gen@v0.19.0
npm run check                # typecheck + tests + build; run before calling a change done
npm run package              # check, minified build, then go-annotations-<version>.vsix
```

Publishing: Marketplace publisher `chihayaanon` (the GitHub account is `tihaya-anon`; the
owner's MCP Config Manager extension uses the same pair). `web-tree-sitter` is a devDependency
because esbuild bundles it, which keeps `node_modules` out of the `.vsix`; it is pinned exactly
because its JS and `.wasm` must match. Record user-visible changes in `CHANGELOG.md`.

`npm test` runs `node --test` directly on the `.ts` sources (Node strips the types), so the
analyzer tests need no build. `test/bundle.test.ts` tests the built bundle and is skipped when
`dist/` is missing; `npm run check` builds before it tests, so it always runs there.

In VS Code, F5 ("Run extension on fixtures") builds and opens `test/fixtures/` in an Extension
Development Host. golang.go and the theme stay enabled so that the decorations are seen over gopls
semantic tokens as a user would see them; for real-world input, open a Kubebuilder project from
there.

## Conventions

- Keep `src/analyze.ts` free of `vscode` imports; everything testable lives there.
- Every analyzer behaviour gets a case in `test/fixtures/sample.go` (marker placement and validity:
  `test/fixtures/markers.go`) and an assertion in the tests. Assertions are written as the
  highlighted source text, not offsets. A claim about what controller-gen does is checked by
  running it on a probe file in a scratch Kubebuilder module, not only by reading its source.
- The package is ESM (`"type": "module"`), sources import each other as `./x.ts`, and only erasable
  TypeScript syntax is allowed (`erasableSyntaxOnly`): no enums, namespaces or parameter
  properties, because Node runs the tests by stripping types.
- The bundle is CommonJS (`dist/extension.cjs`) because the extension host `require()`s it.
- Colours are contributed theme colours (`goAnnotations.*` in `package.json`), never hard-coded in
  code, so users can override them with `workbench.colorCustomizations`.
- Comments explain why, not what.
