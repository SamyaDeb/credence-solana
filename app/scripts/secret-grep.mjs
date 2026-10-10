// c5_no_secret_in_bundle: the real values of the server-side secrets (from the environment or ../.env) must not appear anywhere
// in .next. Prints names and counts only, never a value. Exit 1 on any hit. Usage: node scripts/secret-grep.mjs [dir]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const NAMES = /^(MAINNET_RPC|PYTH_API_KEY|TELEGRAM_BOT_TOKEN|VAPID_[A-Z_]+)$/;
const env = { ...(existsSync('../.env') ? Object.fromEntries(readFileSync('../.env', 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })) : {}), ...process.env };
const secrets = Object.entries(env).filter(([k, v]) => NAMES.test(k) && v);
const needles = new Map();
for (const [k, v] of secrets) {
  const c = new Set([v]);
  const key = v.match(/api-key=([^&]+)/)?.[1]; if (key) c.add(key);
  const path = v.match(/\/\/[^/]+\/(.+)$/)?.[1]; if (path) c.add(path);
  needles.set(k, [...c].filter((x) => x.length >= 8));
}
const root = process.argv[2] ?? '.next';
if (!existsSync(root)) { console.error(`${root} does not exist: build first`); process.exit(2); }
const files = [];
const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else { try { const st = statSync(p); if (st.isFile() && st.size < 50e6) files.push(p); } catch { /* a dangling link */ } } } };
walk(root);
let hits = 0;
for (const [k, ns] of needles) {
  let n = 0;
  for (const f of files) { const d = readFileSync(f); for (const x of ns) if (d.includes(x)) { n++; console.error(`HIT ${k} in ${f}`); } }
  hits += n;
  console.log(`${k}: ${ns.length} value(s) checked, ${n} hit(s)`);
}
console.log(`${files.length} files scanned in ${root}; secrets present: ${secrets.length}`);
process.exit(hits ? 1 : 0);
