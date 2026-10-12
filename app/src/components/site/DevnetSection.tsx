import type { DevnetStatus } from '@/lib/site/devnet';

const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;
const explorer = (k: string) => `https://explorer.solana.com/address/${k}?cluster=devnet`;
const Addr = ({ k }: { k: string }) => <a href={explorer(k)} rel="noreferrer" target="_blank"><code>{short(k)}</code></a>;

function ago(iso: string | null, now: number) {
  if (!iso) return 'none yet';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

/** The devnet deployment, read live from devnet when the page is served (lib/site/devnet.ts). */
export function DevnetSection({ data, now }: { data: DevnetStatus | { error: string } | null; now: number }) {
  if (!data) return null;
  return (
    <>
      <h2 id="devnet">Devnet deployment (live)</h2>
      <p>
        A devnet-only build of the program (only its address differs from the repo&rsquo;s) runs on Solana devnet with stand-in tokens: a test USDC and
        eight test xStocks. A keeper and the monitor run against it around the clock. It opens weekends; it cannot close or settle one, because the
        xStocks, Kamino&rsquo;s markets and its Scope prices exist only on mainnet. Nothing here is mainnet, and no real money is involved.
      </p>
      {'error' in data ? <p className="sx-note" role="note" data-testid="devnet-error">Devnet could not be read just now ({data.error}).</p> : <DevnetBody d={data} now={now} />}
    </>
  );
}

function DevnetBody({ d, now }: { d: DevnetStatus; now: number }) {
  const alerts = d.monitor.filter((l) => l.level !== 'ok');
  // The nearest weekend still in progress (the keeper opens the next four ahead), else the most recent one.
  const pending = d.epochs.filter((e) => e.state !== 'settled' && e.state !== 'voided').map((e) => e.closureId);
  const latest = pending.length ? Math.min(...pending) : d.epochs.length ? d.epochs[0].closureId : null;
  const weekends = new Set(d.epochs.map((e) => e.closureId)).size;
  const current = d.epochs.filter((e) => e.closureId === latest);
  const states = current.reduce<Record<string, number>>((m, e) => ((m[e.state] = (m[e.state] ?? 0) + 1), m), {});
  return (
    <>
      <p className={`sx-fresh ${alerts.length ? 'is-stale' : ''}`} data-testid="devnet-fresh">
        <span className="sx-chip">Live</span> read from devnet {ago(d.asOf, now)}. <span className="sx-src">Source: the program&rsquo;s accounts on devnet.</span>
      </p>
      <div className="sx-grid">
        <section className="sx-card" aria-labelledby="dv-program">
          <h3 id="dv-program">Program</h3>
          <dl className="sx-dl">
            <dt>Address</dt><dd><Addr k={d.programId} /></dd>
            <dt>Deployed in slot</dt><dd>{d.deployedSlot?.toLocaleString('en-US') ?? 'n/a'}</dd>
            <dt>Upgrade authority</dt><dd>{d.authority ? <Addr k={d.authority} /> : 'none (immutable)'}</dd>
            <dt>Paused</dt><dd>{d.config.paused ? 'yes' : 'no'}</dd>
            <dt>Assets</dt><dd>{d.assets.length}</dd>
            <dt>Test USDC</dt><dd><Addr k={d.config.usdcMint} /></dd>
          </dl>
        </section>
        <section className="sx-card" aria-labelledby="dv-keeper">
          <h3 id="dv-keeper">Keeper</h3>
          <dl className="sx-dl">
            <dt>Key</dt><dd><Addr k={d.keeper.pubkey} /></dd>
            <dt>Last transaction</dt><dd>{ago(d.keeper.lastTxAt, now)}</dd>
            <dt>Transactions, last hour</dt><dd>{d.keeper.txLastHour}</dd>
            <dt>Balance</dt><dd>{d.keeper.sol.toFixed(3)} SOL</dd>
          </dl>
          <p className="sx-small">Runs every 30 s. It sends only when a job is due (opening the next weekends, closes, settlement), so quiet hours are normal.</p>
        </section>
        <section className="sx-card" aria-labelledby="dv-monitor">
          <h3 id="dv-monitor">Monitor</h3>
          <ul className="sx-list" data-testid="devnet-monitor">
            {d.monitor.map((l) => <li key={l.what}><strong>{l.level}</strong> {l.what}</li>)}
          </ul>
          <p className="sx-small">The same checks the monitor service runs every 5 minutes.</p>
        </section>
      </div>
      {latest !== null && (
        <>
          <h3 id="dv-epochs">Weekend {String(latest).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')}</h3>
          <p data-testid="devnet-epochs">
            {current.length} of {d.assets.length} assets have an epoch: {Object.entries(states).map(([s, c]) => `${c} ${s}`).join(', ')}.
            {' '}{d.epochs.length} epochs over {weekends} weekends on chain.
          </p>
          <div className="sx-scroll" role="region" aria-label="Devnet epochs" tabIndex={0}>
            <table className="sx-table">
              <caption className="sx-sr">Epochs of the latest weekend on devnet</caption>
              <thead><tr><th scope="col">Asset</th><th scope="col">State</th><th scope="col">Test mint</th></tr></thead>
              <tbody>
                {current.map((e) => {
                  const a = d.assets.find((x) => x.ticker === e.ticker);
                  return <tr key={e.ticker}><th scope="row">{e.ticker}</th><td>{e.state}</td><td>{a ? <Addr k={a.mint} /> : 'n/a'}</td></tr>;
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
