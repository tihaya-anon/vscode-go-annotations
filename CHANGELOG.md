# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-10-30

### Fixed

- The block behind each `key=value` of a marker did not show: it used a theme colour through a CSS
  variable that VS Code does not define for extensions. It is now tinted with the comment colour.

### Changed

- The `goAnnotations.markerArgumentPair` colour is gone (it never took effect);
  `goAnnotations.markers.argumentBlocks` turns the blocks off.

## [0.1.0] - 2026-10-30

First release.

### Added

- Struct tag highlighting: key, name and options.
- Doc comments: the documented name, or a field's json name, in bold; a warning with quick fixes
  when the doc of an exported declaration does not start with it.
- Kubebuilder / controller-gen markers:
  - highlighting, with marker name and first argument split as controller-gen does and each
    `key=value` on a faint block;
  - hover documentation for markers and arguments;
  - completion of marker names valid at the cursor and of missing arguments;
  - checks with controller-gen's own severities, and did-you-mean quick fixes.
- Marker definitions from the workspace's controller-gen in trusted workspaces, cached per
  version, with a built-in set from controller-gen v0.19.0.

[0.1.1]: https://github.com/tihaya-anon/vscode-go-annotations/releases/tag/v0.1.1
[0.1.0]: https://github.com/tihaya-anon/vscode-go-annotations/releases/tag/v0.1.0
