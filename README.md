# Go Annotations

JetBrains-style highlighting for Go in VS Code, layered over the official Go extension and gopls
semantic highlighting:

- struct tags: key, name and options in separate colours;
- doc comments: the name being documented (`Dataset` in `// Dataset is ...`, or a field's json
  name, `spec` in `// spec defines ...`) in bold. A doc of an exported declaration that does not
  start with one of those names gets a warning, with quick fixes that correct the case or insert
  the name;
- controller-gen / Kubebuilder markers such as `// +kubebuilder:validation:Minimum=1`: name in
  bold, arguments in italics. Hovering a marker shows controller-gen's documentation for it, or
  for the argument under the cursor (type, required or optional). Marker names and arguments
  complete after `// +`, `:` and `,`. Markers are checked the way controller-gen reads them:
  errors for what makes it fail (unknown or missing arguments, bad values), warnings for what it
  silently ignores (unknown `kubebuilder:*` markers, markers in a function's doc comment or on the
  wrong kind of declaration).

Doc names and markers are part of comments, so by default they keep the theme's comment colour
and differ only in weight and style; struct tags get colours.

## Settings

| Setting | Default |
| --- | --- |
| `goAnnotations.structTags.enabled` | `true` |
| `goAnnotations.docComments.enabled` | `true` |
| `goAnnotations.docComments.checkStart` | `true` |
| `goAnnotations.markers.enabled` | `true` |
| `goAnnotations.comments.useColors` | `false` |
| `goAnnotations.markers.diagnostics` | `true` |
| `goAnnotations.markers.controllerGenPath` | `""` |

Marker names are told apart from their first argument (`+kubebuilder:resource:scope=Cluster` is
marker `kubebuilder:resource` with argument `scope`) using the markers controller-gen knows. In a
trusted workspace the extension asks `controllerGenPath`, else `bin/controller-gen` in a workspace
folder, else `controller-gen` on `PATH`; otherwise a built-in list from controller-gen v0.19.0 is
used. The *Go Annotations* output channel (command *Go Annotations: Show Log*) says which.

Colours are theme colours and can be overridden (doc names and markers only take theirs with
`goAnnotations.comments.useColors` on):

```jsonc
"workbench.colorCustomizations": {
  "goAnnotations.structTagKey": "#C586C0",
  "goAnnotations.docCommentName": "#629755"
}
```

Available: `structTagKey`, `structTagName`, `structTagOption`, `docCommentName`, `markerPrefix`,
`markerName`, `markerArgument`, `markerValue` (each prefixed `goAnnotations.`).

## Development

See [AGENTS.md](AGENTS.md).
