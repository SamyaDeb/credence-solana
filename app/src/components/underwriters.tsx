'use client';
// Underwriters (task 4.3): the vault read from the chain (every figure is a stored field or a stated function of
// them, see lib/vault.ts and test/vault-accounts.test.ts), the wallet's LP position with deposit, request_withdraw and
// queued requests, and the Gap Cover backtest from data/backtest.
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { TICKET, USDC_MINT, ata, bn, createAtaIx, pdas } from '@/lib/credence';
import { fixed, short, usdc, usdc6, utc } from '@/lib/format';
import { TxError, redact, sendTx } from '@/lib/tx';
import { type TicketView, type VaultView, loadVault, ticketLabel, ticketReady, ticketsOf } from '@/lib/vault';
import { BacktestChart } from './backtest';
import { useApp } from './providers';

type Loaded = Awaited<ReturnType<typeof loadVault>>;

export function Underwriters() {
  const { conn, prog, signer, version, bump } = useApp();
  const [vault, setVault] = useState<Loaded | null>(null);
  const [mine, setMine] = useState<{ shares: bigint; usdc: bigint; tickets: TicketView[] } | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const v = await loadVault(conn, prog);
      setVault(v);
      if (signer) {
        const [sh, u, tickets] = await Promise.all([
          conn.getTokenAccountBalance(ata(signer.publicKey, pdas.shares()), 'confirmed').then((x) => BigInt(x.value.amount)).catch(() => 0n),
          conn.getTokenAccountBalance(ata(signer.publicKey, USDC_MINT), 'confirmed').then((x) => BigInt(x.value.amount)).catch(() => 0n),
          ticketsOf(prog, signer.publicKey),
        ]);
        setMine({ shares: sh, usdc: u, tickets });
      } else setMine(null);
    } catch (e) { setErr(redact((e as Error).message)); }
  }, [conn, prog, signer]);
  useEffect(() => { void load(); }, [load, version]);

  return (
    <div className="stack">
      <div>
        <h1>Underwriters</h1>
        <p className="lede">LPs deposit USDC into one vault that backs every weekend&apos;s gap protection. Premiums are earned when the
          weekend settles; payouts come out of equity. Deposits and withdrawals made while a weekend is live wait in a queue
          until it settles (INV-5, INV-6).</p>
      </div>
      {err && <div className="panel err">{err}</div>}
      {vault && <VaultPanel v={vault} />}
      {signer && vault && mine && <LpPanel v={vault} mine={mine} onDone={() => { bump(); void load(); }} />}
      {!signer && <div className="panel">Connect a wallet (or the demo burner) to deposit.</div>}
      <BacktestChart />
    </div>
  );
}

function VaultPanel({ v }: { v: Loaded }) {
  const f = v.figures;
  const s = v.view;
  return (
    <div className="panel" data-testid="vault">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
        <h2 style={{ margin: 0 }}>Vault</h2>
        <span className="mono faint">{pdas.vault().toBase58()}{v.paused ? ' · PAUSED' : ''}</span>
      </div>
      <div className="grid g4" style={{ rowGap: 22 }}>
        <Stat k="LP equity" v={usdc(s.equity)} unit="USDC" s={`${usdc6(s.equity)} · vault.equity`} id="equity" />
        <Stat k="NAV per share" v={fixed(f.navPerShare6, 6, 6)} unit="USDC" s={`equity / ${usdc6(v.supply)} shares, rounded down`} id="nav" />
        <Stat k="Premiums unearned" v={usdc(s.premiumsUnearned)} unit="USDC" s={`${usdc6(s.premiumsUnearned)} · live weekends`} id="unearned" />
        <Stat k="Premiums earned (lifetime)" v={usdc(f.premiumsEarned)} unit="USDC" s={`total_premiums ${usdc6(s.totalPremiums)} − unearned`} id="earned" />
        <Stat k="Reserved worst-case loss" v={usdc(s.reservedTotal)} unit="USDC" s={`limit ⌊u_max × equity⌋ = ${usdc(f.capacityLimit)}`} id="reserved" />
        <Stat k="Utilisation" v={`${(f.utilisationPpm / 10_000).toFixed(4)}%`} s={`reserved / limit (u_max ${fixed(v.uMaxWad * 100n, 18, 0)}%), rounded down`} id="util" />
        <Stat k="Payouts (lifetime)" v={usdc(s.totalPayouts)} unit="USDC" s={usdc6(s.totalPayouts)} id="payouts" />
        <Stat k="Live weekends" v={String(s.liveGroups)} s={s.live.length ? s.live.join(', ') : 'none: deposits are immediate'} id="live" />
      </div>
      <hr />
      <div className="row muted" style={{ gap: 28, fontSize: 13 }}>
        <span>Queued deposits <b className="mono">{usdc6(s.queuedDeposits)}</b> USDC</span>
        <span>Queued withdrawals <b className="mono">{fixed(s.queuedWithdrawShares, 6, 6)}</b> shares</span>
        <span>Share supply <b className="mono">{fixed(v.supply, 6, 6)}</b></span>
        <span>Latest weekend <b className="mono">{s.latestGroup || '—'}</b></span>
      </div>
    </div>
  );
}

function Stat({ k, v, unit, s, id }: { k: string; v: string; unit?: string; s?: string; id: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v" data-testid={`vault-${id}`}>{v}{unit && <small>{unit}</small>}</div>
      {s && <div className="s">{s}</div>}
    </div>
  );
}

function LpPanel({ v, mine, onDone }: { v: Loaded; mine: { shares: bigint; usdc: bigint; tickets: TicketView[] }; onDone: () => void }) {
  const { conn, prog, signer } = useApp();
  const [dep, setDep] = useState('10000');
  const [wd, setWd] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const s: VaultView = v.view;
  const newest = s.live.length ? Math.max(...s.live) : 0;
  const locked = s.liveGroups > 0;
  const value = (mine.shares * v.figures.navPerShare6) / 1_000_000n;

  const run = useCallback(async (label: string, ixs: TransactionInstruction[]) => {
    if (!signer) return;
    setBusy(label); setMsg(null);
    try {
      const r = await sendTx(conn, signer, ixs);
      setMsg({ ok: true, text: `${label}: ${r.signature.slice(0, 20)}… · ${r.cu.toLocaleString()} CU` });
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof TxError ? `${label} failed (${e.stage}): ${e.message}` : redact((e as Error).message) });
    } finally { setBusy(''); }
  }, [conn, signer, onDone]);

  const amount = useMemo(() => BigInt(Math.round(Math.max(0, Number(dep) || 0) * 1e6)), [dep]);
  const shares = useMemo(() => BigInt(Math.round(Math.max(0, Number(wd) || 0) * 1e6)), [wd]);

  async function deposit() {
    const me = signer!.publicKey;
    if (!locked) {
      await run('deposit', [createAtaIx(me, me, pdas.shares()), await prog.methods.deposit(bn(amount)).accountsPartial({
        depositor: me, vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), depositorUsdc: ata(me, USDC_MINT), depositorShares: ata(me, pdas.shares()), shareEscrow: pdas.shareEscrow(),
      }).instruction()]);
    } else {
      await run('request_deposit', [await prog.methods.requestDeposit(bn(amount)).accountsPartial({
        depositor: me, vaultUsdc: pdas.vaultUsdc(), depositorUsdc: ata(me, USDC_MINT), ticket: pdas.depositTicket(me, newest),
      }).instruction()]);
    }
  }

  async function withdraw() {
    const me = signer!.publicKey;
    await run('request_withdraw', [await prog.methods.requestWithdraw(bn(shares)).accountsPartial({
      owner: me, shareMint: pdas.shares(), shareEscrow: pdas.shareEscrow(), ownerShares: ata(me, pdas.shares()), ticket: pdas.withdrawTicket(me, newest),
    }).instruction()]);
  }

  async function process(t: TicketView) {
    const me = signer!.publicKey;
    if (t.kind === TICKET.DEPOSIT) {
      await run('process_deposit', [createAtaIx(me, t.owner, pdas.shares()), await prog.methods.processDeposit().accountsPartial({
        caller: me, shareMint: pdas.shares(), ticket: t.key, owner: t.owner, ownerShares: ata(t.owner, pdas.shares()), shareEscrow: pdas.shareEscrow(),
      }).instruction()]);
    } else {
      await run('process_withdrawal', [createAtaIx(me, t.owner, USDC_MINT), await prog.methods.processWithdrawal().accountsPartial({
        caller: me, vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), shareEscrow: pdas.shareEscrow(), ticket: t.key, owner: t.owner, ownerUsdc: ata(t.owner, USDC_MINT),
      }).instruction()]);
    }
  }

  return (
    <div className="panel" data-testid="lp">
      <h2>Your LP position</h2>
      <div className="grid g3" style={{ marginBottom: 18 }}>
        <div className="stat"><div className="k">Shares</div><div className="v" data-testid="lp-shares">{fixed(mine.shares, 6, 6)}</div></div>
        <div className="stat"><div className="k">Value at NAV</div><div className="v">{usdc(value)}<small>USDC</small></div><div className="s">shares × NAV, rounded down; withdrawals pay at the NAV when processed</div></div>
        <div className="stat"><div className="k">Wallet USDC</div><div className="v">{usdc(mine.usdc)}</div></div>
      </div>
      <div className="grid g2">
        <div className="stack" style={{ gap: 8 }}>
          <h3>Deposit</h3>
          <div className="row">
            <input value={dep} onChange={(e) => setDep(e.target.value)} style={{ width: 160 }} data-testid="lp-deposit-amount" /> <span className="muted">USDC</span>
            <button className="primary" disabled={!!busy || amount === 0n} onClick={deposit} data-testid="lp-deposit">{locked ? 'Queue deposit' : 'Deposit'}</button>
          </div>
          <div className="note">{locked ? `Weekend ${s.live.join(', ')} is live: the deposit waits in the queue and joins equity at the NAV after it settles (request_deposit).` : 'No weekend is live: shares are minted now at the current NAV (deposit).'}</div>
        </div>
        <div className="stack" style={{ gap: 8 }}>
          <h3>Withdraw</h3>
          <div className="row">
            <input value={wd} placeholder="shares" onChange={(e) => setWd(e.target.value)} style={{ width: 160 }} />
            <button className="small" onClick={() => setWd(fixed(mine.shares, 6, 6).replace(/,/g, ''))}>max</button>
            <button disabled={!!busy || shares === 0n || shares > mine.shares} onClick={withdraw}>Request withdrawal</button>
          </div>
          <div className="note">request_withdraw moves the shares into escrow; they still bear the live weekends&apos; losses and earn their premiums, and pay out at the NAV once {newest ? `weekend ${newest} settles` : 'processed'}.</div>
        </div>
      </div>
      {msg && <div className={msg.ok ? 'note accent' : 'err'} style={{ marginTop: 10 }} data-testid="lp-msg">{msg.text}</div>}
      {mine.tickets.length > 0 && (
        <>
          <h3 style={{ marginTop: 18 }}>Queued requests</h3>
          <table>
            <thead><tr><th>Ticket</th><th>Kind</th><th className="r">Amount</th><th>Requested</th><th>Waits for weekend</th><th>Status</th><th /></tr></thead>
            <tbody>
              {mine.tickets.map((t) => {
                const ready = ticketReady(t, s.live);
                return (
                  <tr key={t.key.toBase58()}>
                    <td className="mono">{short(t.key, 6)}</td><td>{ticketLabel(t)}</td>
                    <td className="r">{t.kind === TICKET.DEPOSIT ? `${usdc6(t.amount)} USDC` : `${fixed(t.amount, 6, 6)} shares`}</td>
                    <td className="mono">{utc(t.requestedAt)}</td><td>{t.waitGroup || 'none'}</td>
                    <td><span className={`pill ${ready ? 'ok' : 'warn'}`}>{ready ? 'ready' : 'waiting'}</span></td>
                    <td className="r">{ready && <button className="small" disabled={!!busy} onClick={() => process(t)}>Process</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="note">Processing is permissionless (the keeper does it after settlement); anyone may press it once a ticket is ready.</div>
        </>
      )}
      <div className="note" style={{ marginTop: 8 }}>Share mint {short(pdas.shares(), 6)} · your share account {short(ata(signer?.publicKey ?? PublicKey.default, pdas.shares()), 6)}</div>
    </div>
  );
}
