// Runs a controller-gen binary to read the markers it knows. No vscode import: the extension
// decides which binary to trust and where to cache the result.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// The generators whose markers appear in Kubebuilder API types and controllers; together they
// cover every kubebuilder:* marker controller-gen reads, which the unknown-marker check relies
// on. rbac refuses to print help without its required roleName option; the value is never used.
// applyconfiguration repeats the crd markers, which the registry merges.
const GENERATORS = ['crd', 'rbac:roleName=help', 'webhook', 'object', 'applyconfiguration'];

const TIMEOUT_MS = 10_000;

// `controller-gen --version` prints `Version: v0.19.0`.
export async function controllerGenVersion(bin: string): Promise<string> {
  const { stdout } = await run(bin, ['--version'], { timeout: TIMEOUT_MS });
  const match = /^Version:\s*(\S+)/m.exec(stdout);
  if (!match) throw new Error(`${bin} --version: unexpected output ${JSON.stringify(stdout)}`);
  return match[1]!;
}

// `-wwww` is the JSON form of `-ww`: one array of marker categories per generator.
export async function controllerGenHelp(bin: string): Promise<unknown[]> {
  const outputs = await Promise.all(
    GENERATORS.map((gen) => run(bin, [gen, '-wwww'], { timeout: TIMEOUT_MS, maxBuffer: 16 << 20 })),
  );
  return outputs.flatMap(({ stdout }) => JSON.parse(stdout) as unknown[]);
}
