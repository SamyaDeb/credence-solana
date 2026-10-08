import type { Metadata } from 'next';
import { Empty, PageHead, Pill } from '@/components/app/ui';

export const metadata: Metadata = { title: 'Auctions' };

export default function Page() {
  return (
    <>
      <PageHead title="Auctions" sub="Reopen auctions for positions the Monday gap leaves underwater." right={<Pill tone="soft">Not live on Solana yet</Pill>} />
      <Empty icon="lock" title="Not live on Solana yet">The reopen backstop (Credence's vault buying liquidated collateral at the open) is not built on Solana yet. Phase 1 pays the gap into the position after the open instead.</Empty>
    </>
  );
}
