# Go Annotations

GoLand-style highlighting for Go in VS Code, layered over the official Go extension and gopls
semantic highlighting, with first-class support for Kubebuilder / controller-gen markers.

## Features

### Struct tags

Keys, names and options in separate colours: `json` / `name` / `omitempty` in
`` `json:"name,omitempty"` ``.

### Doc comments

The name a doc comment documents is set in bold: `Dataset` in `// Dataset is ...`, or a field's
json name, `spec` in `// spec defines ...`, as Kubernetes API conventions write it.

A doc comment of an exported declaration that does not start with one of those names gets a
warning, with quick fixes that correct the case or insert the name.

### Markers

`// +kubebuilder:validation:Minimum=1` and friends:

- **Highlighting.** The marker name in bold, argument names in italics, each `key=value` on a faint
  block of its own so that long markers read as separate pieces. Name and first argument are split
  exactly as controller-gen does (`+kubebuilder:resource:scope=Cluster` is marker
  `kubebuilder:resource` with argument `scope`).
- **Hover.** controller-gen's documentation for the marker, or for the argument under the cursor:
  its type and whether it is required.
- **Completion.** Marker names valid where the cursor is after `// +` (field markers above a
  field, type and package markers above a type), then the arguments not yet given, required
  first.
- **Checks**, following what controller-gen actually does:
  - errors for what makes it fail: unknown or missing arguments, values that are not an int or
    a bool where one is expected, `,` instead of `;` between list items;
  - warnings for what it silently ignores: unknown `kubebuilder:*` markers (with a "did you mean"
    quick fix), markers on the wrong kind of declaration, and markers where it does not look —
    for example `+kubebuilder:rbac` inside a function's doc comment, or a third comment block
    above a field.

Doc names and markers are part of comments, so by default they keep the theme's comment colour and
differ only in weight and style. Struct tags are code and get colours.

## Requirements

A Go file is all it needs; it works next to the official Go extension, with gopls semantic tokens on
or off.

For markers, the extension knows the markers of controller-gen v0.19.0. In a trusted workspace it
asks the project's own controller-gen instead, so the definitions match the version the project
uses: `goAnnotations.markers.controllerGenPath` if set, else `bin/controller-gen` in a workspace
folder (where Kubebuilder's Makefile installs it), else `controller-gen` on `PATH`. The
*Go Annotations* output channel (command **Go Annotations: Show Log**) says which set is in use. In
an untrusted workspace no binary is run.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `goAnnotations.structTags.enabled` | `true` | Highlight struct tags. |
| `goAnnotations.docComments.enabled` | `true` | Embolden documented names. |
| `goAnnotations.docComments.checkStart` | `true` | Warn when a doc does not start with its name. |
| `goAnnotations.comments.useColors` | `false` | Colour doc names and markers instead of only changing weight and style. |
| `goAnnotations.markers.enabled` | `true` | Highlight, hover and complete markers. |
| `goAnnotations.markers.diagnostics` | `true` | Check markers. |
| `goAnnotations.markers.argumentBlocks` | `true` | A faint block behind each `key=value`. |
| `goAnnotations.markers.controllerGenPath` | `""` | The controller-gen to read markers from. |

## Colours

Colours are theme colours and can be overridden. Doc names and markers only take theirs with
`goAnnotations.comments.useColors` on.

```jsonc
"workbench.colorCustomizations": {
  "goAnnotations.structTagKey": "#C586C0",
  "goAnnotations.markerName": "#BBB529"
}
```

Available, each prefixed `goAnnotations.`: `structTagKey`, `structTagName`, `structTagOption`,
`docCommentName`, `markerPrefix`, `markerName`, `markerArgument` and `markerValue`. The block
behind each `key=value` is tinted with the comment colour itself rather than a colour of its own;
`goAnnotations.markers.argumentBlocks` turns it off.

## Development

See [AGENTS.md](AGENTS.md) and [docs/](docs/design.md).

## License

[MIT](LICENSE)
