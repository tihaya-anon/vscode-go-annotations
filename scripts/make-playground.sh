#!/usr/bin/env bash
# Rebuild playground/: a throwaway copy of a real Kubebuilder project, opened by the F5 launch
# config so the extension is exercised on struct tags, doc comments and markers as they occur in
# practice. It is gitignored; delete it freely and rerun this script.
set -euo pipefail

source_repo=${1:-$HOME/workspace/personal/k8s-ai-platform}
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

rm -rf "$root/playground"
# A clone of committed state only: no bin/, caches or uncommitted work from the source checkout.
git clone --quiet --depth 1 "file://$source_repo" "$root/playground"
# Detached from the source so nothing done in the playground can be pushed back to it.
git -C "$root/playground" remote remove origin
echo "playground/ <- $source_repo @ $(git -C "$root/playground" rev-parse --short HEAD)"
