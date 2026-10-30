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

## Next steps

1. Run it in VS Code (above) and fix whatever that shows.
2. Marker registry from `controller-gen <gen> -ww` (see [design.md](design.md#next-phase-marker-registry)):
   start with a parser for that output plus unit tests on captured output under `test/fixtures/`,
   then use it to split marker name vs argument exactly.
3. Hover, completion and diagnostics for markers.
4. Only if large files feel slow: incremental parsing with `tree.edit()` from
   `TextDocumentChangeEvent.contentChanges`.
5. Decide a licence (package.json says `UNLICENSED` for now) and whether to publish.
