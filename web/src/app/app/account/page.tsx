import type { Metadata } from 'next';
import { Empty, PageHead } from '@/components/app/ui';

export const metadata: Metadata = { title: 'Account' };

export default function Page() {
  return (
    <>
      <PageHead title="Account" sub="Your wallet, balances, policies and LP shares." />
      <Empty title="Coming in the next build step" />
    </>
  );
}
