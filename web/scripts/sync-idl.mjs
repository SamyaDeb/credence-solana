// Copies the program's IDL from `anchor build` (target/idl) into the app so the client bundle and the tests decode
// accounts with the exact deployed interface. Fails if the program was never built.
import { copyFileSync, existsSync } from 'node:fs';
const src = new URL('../../target/idl/credence_core.json', import.meta.url);
if (!existsSync(src)) {
  console.error('target/idl/credence_core.json is missing: run `anchor build --arch v0` at the repo root');
  process.exit(1);
}
copyFileSync(src, new URL('../src/lib/idl.json', import.meta.url));
