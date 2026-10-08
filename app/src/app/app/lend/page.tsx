import type { Metadata } from 'next';
import { Empty, PageHead, Pill } from '@/components/app/ui';

export const metadata: Metadata = { title: 'Lend' };

export default function Page() {
  return (
    <>
      <PageHead title="Lend" sub="Lend USDC to Credence borrowers." right={<Pill tone="soft">Not live on Solana yet</Pill>} />
      <Empty icon="lock" title="Not live on Solana yet">Credence's own lending market is not on Solana yet. On Solana, Kamino is the lender: Credence covers Kamino loans for the weekend (Borrow) and pays underwriters for it (Underwrite).</Empty>
    </>
  );
}
