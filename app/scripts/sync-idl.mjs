// The app reads the program through @credence/sdk (packages/sdk), which embeds the IDL from `anchor build`. This builds
// the SDK (installing its dependencies first when they are missing) so the app and its tests use the exact deployed
// interface. Fails if the program was never built.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const sdk = fileURLToPath(new URL('../../packages/sdk/', import.meta.url));
if (!existsSync(new URL('../../target/idl/credence_core.json', import.meta.url))) {
  console.error('target/idl/credence_core.json is missing: run `anchor build --arch v0` at the repo root');
  process.exit(1);
}
const run = (args) => execFileSync('pnpm', ['--dir', sdk, ...args], { stdio: 'inherit' });
if (!existsSync(`${sdk}node_modules`)) run(['install', '--frozen-lockfile']);
// (always rebuilt: tsup takes about a second, and the IDL may have changed since the last build)
run(['build']);
