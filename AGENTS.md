# Agent guidance

`AGENTS.md` is the source of truth; `CLAUDE.md` is a gitignored copy for Claude. Edit `AGENTS.md`,
then `cp AGENTS.md CLAUDE.md`.

## What this is

A VS Code extension that adds JetBrains-style highlighting to Go on top of the official Go extension:

- struct tags split into key / name / options (`json:"name,omitempty"`);
- doc comments of declarations, struct fields and interface methods, distinct from other comments;
- controller-gen / Kubebuilder markers (`// +kubebuilder:validation:Minimum=1`).

It was started from the `k8s-ai-platform` repository (`~/workspace/personal/k8s-ai-platform`),
whose Kubebuilder API types are the real-world test input. Read [docs/design.md](docs/design.md)
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
src/controllerGen.ts  runs a controller-gen binary for its version and marker help
src/controller-gen-markers.json  built-in registry, used until/unless a workspace one loads
src/extension.ts      vscode glue: decoration types, debounce, per-document cache, registry loading
test/analyze.test.ts  analyzer against test/fixtures/sample.go and the playground API types
test/markers.test.ts  registry parsing and name splitting; live check against playground/bin
test/markerHover.test.ts  hover text against the built-in registry
test/bundle.test.ts   require()s dist/extension.cjs with a stub vscode module and activates it
scripts/build.mjs     esbuild bundle + copies both .wasm files into dist/
scripts/make-playground.sh  clones k8s-ai-platform into playground/ (gitignored)
scripts/capture-markers.sh  regenerates src/controller-gen-markers.json from a controller-gen
playground/           throwaway Kubebuilder project the F5 launch config opens
```

`playground/` is a clone of another repository. Its own `AGENTS.md` and docs describe that
project, not this one; do not follow them here, and never commit changes inside it.

## Commands

```bash
npm install
scripts/make-playground.sh   # once, or to refresh the playground
(cd playground && make controller-gen)  # optional: enables the live controller-gen tests
npm run check                # typecheck + tests + build; run before calling a change done
```

`npm test` runs `node --test` directly on the `.ts` sources (Node strips the types), so the
analyzer tests need no build. `test/bundle.test.ts` tests the built bundle and is skipped when
`dist/` is missing; `npm run check` builds before it tests, so it always runs there.

In VS Code, F5 ("Run extension on playground") builds and opens `playground/` in an Extension
Development Host with the other extensions still enabled, so the decorations are seen over gopls
semantic tokens as a user would see them.

## Conventions

- Keep `src/analyze.ts` free of `vscode` imports; everything testable lives there.
- Every analyzer behaviour gets a case in `test/fixtures/sample.go` and an assertion in
  `test/analyze.test.ts`. Assertions are written as the highlighted source text, not offsets.
- The package is ESM (`"type": "module"`), sources import each other as `./x.ts`, and only erasable
  TypeScript syntax is allowed (`erasableSyntaxOnly`): no enums, namespaces or parameter
  properties, because Node runs the tests by stripping types.
- The bundle is CommonJS (`dist/extension.cjs`) because the extension host `require()`s it.
- Colours are contributed theme colours (`goAnnotations.*` in `package.json`), never hard-coded in
  code, so users can override them with `workbench.colorCustomizations`.
- Comments explain why, not what.
