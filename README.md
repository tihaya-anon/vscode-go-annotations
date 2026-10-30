# Go Annotations

JetBrains-style highlighting for Go in VS Code, layered over the official Go extension and gopls
semantic highlighting:

- struct tags: key, name and options in separate colours;
- doc comments of declarations, struct fields and interface methods, distinct from other comments;
- controller-gen / Kubebuilder markers such as `// +kubebuilder:validation:Minimum=1`.

## Settings

| Setting | Default |
| --- | --- |
| `goAnnotations.structTags.enabled` | `true` |
| `goAnnotations.docComments.enabled` | `true` |
| `goAnnotations.docComments.fontStyle` | `"italic"` |
| `goAnnotations.markers.enabled` | `true` |

Colours are theme colours and can be overridden:

```jsonc
"workbench.colorCustomizations": {
  "goAnnotations.structTagKey": "#C586C0",
  "goAnnotations.docComment": "#629755"
}
```

Available: `structTagKey`, `structTagName`, `structTagOption`, `docComment`, `markerPrefix`,
`markerName`, `markerArgument`, `markerValue` (each prefixed `goAnnotations.`).

## Development

See [AGENTS.md](AGENTS.md).
