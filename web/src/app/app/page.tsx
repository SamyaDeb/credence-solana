import type { Metadata } from 'next';
import { Empty, PageHead } from '@/components/app/ui';

export const metadata: Metadata = { title: 'Overview' };

export default function Page() {
  return (
    <>
      <PageHead title="Overview" sub="Your Kamino xStocks positions, their weekend risk and cover, and the coming bell." />
      <Empty title="Coming in the next build step" />
    </>
  );
}
