#!/usr/bin/env bash
# Regenerates src/controller-gen-markers.json, the marker registry used when no controller-gen is
# found, from `controller-gen <generator> -wwww` (JSON help).
#
#   scripts/capture-markers.sh [path/to/controller-gen]   # default: bin/controller-gen
set -euo pipefail
cd "$(dirname "$0")/.."

bin=${1:-bin/controller-gen}
out=src/controller-gen-markers.json
version=$("$bin" --version | sed -n 's/^Version: //p')

node --input-type=module - "$bin" "$version" "$out" <<'EOF'
import { writeFileSync } from 'node:fs';
import { controllerGenHelp } from './src/controllerGen.ts';

const [bin, version, out] = process.argv.slice(2);
const categories = await controllerGenHelp(bin);
writeFileSync(out, `${JSON.stringify({ version, categories }, null, 1)}\n`);
console.log(`${out}: controller-gen ${version}`);
EOF
