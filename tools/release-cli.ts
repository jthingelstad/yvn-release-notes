/** The release tools' one entry point. scripts/build-release.sh bundles it into
 * dist/release/index.js, so scripts/release.sh runs it with no npm install
 * where the cloud credentials are. Errors print a message, never an SDK
 * response.
 *
 *   package --build-dir D --native-modules M --out O   packaging, no AWS
 *   upload --artifacts O --commit SHA                  prints the code parameters
 *   policies                                           the endpoint grants
 *   probe --commit SHA                                 checks the finished release
 */
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageRelease } from './package-native.ts';
import { uploadArtifacts } from './native-artifacts.ts';
import { ensurePolicies } from './web-platform.ts';
import { probe } from './release-probe.ts';

function options(args: string[], allowed: string[]) {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (allowed.includes(key) && args[i + 1] && !(key in values)) values[key] = args[++i]!;
    else throw new Error('Invalid release option');
  }
  return values;
}
const absolute = (value: string | undefined) => {
  if (!value || !isAbsolute(value)) throw new Error('An absolute path is required');
  return value;
};
const commitOf = (value: string | undefined) => {
  if (!value || !/^[a-f0-9]{40}$/.test(value)) throw new Error('A committed build is required');
  return value;
};

export async function main(argv: string[]): Promise<string> {
  if (process.versions.node.split('.')[0] !== '24') throw new Error('Release tooling requires Node 24');
  const [command, ...args] = argv;
  if (command === 'package') {
    const o = options(args, ['--build-dir', '--native-modules', '--out']);
    const manifest = await packageRelease(
      absolute(o['--build-dir']),
      absolute(o['--native-modules']),
      absolute(o['--out'])
    );
    return JSON.stringify({ artifacts: manifest.artifacts.length });
  }
  if (command === 'upload') {
    const o = options(args, ['--artifacts', '--commit']);
    const { parameters } = await uploadArtifacts(absolute(o['--artifacts']), commitOf(o['--commit']));
    // One line of Key=value words for `aws cloudformation deploy --parameter-overrides`.
    return Object.entries(parameters)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
  }
  if (command === 'policies') {
    if (args.length) throw new Error('Invalid release option');
    return JSON.stringify(await ensurePolicies());
  }
  if (command === 'probe') {
    return JSON.stringify(await probe(commitOf(options(args, ['--commit'])['--commit'])));
  }
  throw new Error('Unknown release command');
}

// Real paths: macOS temporary folders are /var, which Node reports as /private/var.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then(
    (output) => console.info(output),
    (error: unknown) => {
      // SDK error names, never response bodies/headers or credential chains.
      console.error(
        error instanceof Error ? (error.name === 'Error' ? error.message : error.name) : 'Release tool failed'
      );
      process.exitCode = 1;
    }
  );
