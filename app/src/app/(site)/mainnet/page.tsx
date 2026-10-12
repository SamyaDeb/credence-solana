import type { Metadata } from 'next';
import { MainnetView } from '@/components/site/MainnetView';
import { loadSnapshot } from '@/lib/site/load';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Mainnet view: the weekend gap | Credence',
  description: 'The 24/7 price against the Friday close for eight tokenized stocks, whether the lender’s price is frozen, the weekend gap odds, and the weekend risk of Kamino and Jupiter Lend borrowers. Computed off-chain from mainnet data.',
};

export default async function Page() {
  const s = await loadSnapshot();
  return <MainnetView data={{ gap: s.gap, scan: s.scan }} now={Date.now()} />;
}
