'use client';
// Account: the connected wallet, its SOL, USDC and xStock balances, its policies with their state and payout, its LP
// shares, and its activity — all read from the chain.
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022 } from '@/lib/credence';
import { fixed, num, usdc } from '@/lib/format';
import { useAssets, useEpochs } from '@/lib/hooks/chain';
import { usePolicies } from '@/lib/hooks/positions';
import { useBalances, useLpPosition, useQueue, useTokenBalance, useVault } from '@/lib/hooks/vault';
import { useSolana } from '../Providers';
import { ActivityList, H, KV, Note, PageHead, Sim, StatBlock } from '../ui';
import { Policies } from './BorrowView';
import { activityOf } from './OverviewView';
import { ConnectNote } from './shared';

function XBalance({ owner, ticker, mint }: { owner: PublicKey; ticker: string; mint: PublicKey }) {
  const b = useTokenBalance(owner, mint, TOKEN_2022);
  return <>{b.data != null ? `${fixed(b.data, 8, 4)} ${ticker}` : `0 ${ticker}`}</>;
}

export function AccountView() {
  const { signer } = useSolana();
  const owner = signer?.publicKey;
  const bal = useBalances(owner);
  const assets = useAssets();
  const lp = useLpPosition(owner);
  const vault = useVault();
  const queue = useQueue(owner);
  const policies = usePolicies(owner);
  const epochs = useEpochs();
  const nav6 = vault.data?.figures.navPerShare6;
  const shares = lp.data?.shares ?? 0n;
  const activity = activityOf(policies.data ?? [], queue.data ?? []);
  const paid = (policies.data ?? []).reduce((a, p) => a + p.payout, 0n);
  const premiums = (policies.data ?? []).reduce((a, p) => a + p.premium, 0n);

  return (
    <>
      <PageHead title="Account" sub="Your wallet, balances, policies and LP shares, read from the chain." />
      {!signer ? <ConnectNote>Connect a wallet to see your account.</ConnectNote> : (
        <div className="cx-grid">
          <div className="cx-col">
            <section>
              <H right={signer.kind === 'burner' ? <Sim title="A local keypair kept in this browser's storage">demo burner wallet</Sim> : <small>wallet standard</small>}>Wallet</H>
              <KV rows={[
                ['Address', <span key="a" className="cx-mono" data-testid="account-address">{signer.publicKey.toBase58()}</span>],
                ['SOL', bal.data ? num(bal.data.sol, 4) : '—'],
                ['USDC', bal.data ? (bal.data.usdc === null ? '0.00 (no account)' : <span key="u" data-testid="usdc">{usdc(bal.data.usdc)}</span>) : '—'],
                ...((assets.data ?? []).map((a) => [a.ticker, <XBalance key={a.ticker} owner={signer.publicKey} ticker={a.ticker} mint={a.mint} />] as [string, React.ReactNode])),
              ]} />
            </section>
            <Policies owner={signer.publicKey} epochs={epochs.data ?? []} />
            {!policies.isLoading && !(policies.data?.length) && <section><H>Your policies</H><Note icon="shield">No gap cover bought from this wallet yet.</Note></section>}
            <section>
              <H right={<span className="cx-chip">Newest first</span>}>Activity</H>
              {activity.length ? <ActivityList items={activity} /> : <Note icon="clock">Nothing yet. Policies, payouts and LP requests appear here, read from the chain.</Note>}
            </section>
          </div>
          <aside className="cx-aside">
            <StatBlock label="Paid into your positions" value={usdc(paid)} chip="USDC, lifetime" testId="account-paid" />
            <KV rows={[['Policies', String(policies.data?.length ?? 0)], ['Premiums paid', `${usdc(premiums)} USDC`]]} />
            <div>
              <H>LP position</H>
              <KV rows={[
                ['Shares', fixed(shares, 6, 6)],
                ['Value at NAV', nav6 !== undefined ? `${usdc((shares * nav6) / 1_000_000n)} USDC` : '—'],
                ['Queued requests', String(queue.data?.length ?? 0)],
              ]} />
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
