// The fork's clock is real time, so on a Friday evening or a weekend no epoch is on sale and the specs that buy cover have
// nothing to buy. Like Demo mode, move it with a surfpool cheatcode to 4 hours before the demo weekend's close (inside the
// sale window, before the bell). A clock already past that is left alone (time only moves forward).
export default async function globalSetup() {
  const app = process.env.APP_URL ?? 'http://localhost:3000';
  const rpc = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
  const out = await (await fetch(`${app}/api/demo/step`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: 'status' }) })).text();
  const m = out.match(/@@result (.*)/);
  if (!m) throw new Error(`demo status: ${out.slice(-300)}`);
  const { chainNow, close } = JSON.parse(m[1]) as { chainNow: number; close: number };
  const target = close - 4 * 3600;
  if (chainNow >= target) return;
  const r = await (await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'surfnet_timeTravel', params: [{ absoluteTimestamp: target * 1000 }] }) })).json() as { error?: unknown };
  if (r.error) throw new Error(`surfnet_timeTravel: ${JSON.stringify(r.error)}`);
}
