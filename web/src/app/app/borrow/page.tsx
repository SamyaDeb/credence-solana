import type { Metadata } from 'next';
import { Empty, PageHead } from '@/components/app/ui';

export const metadata: Metadata = { title: 'Borrow' };

export default function Page() {
  return (
    <>
      <PageHead title="Borrow" sub="Your Kamino xStocks positions, what a Monday gap does to them, and gap cover before the bell." />
      <Empty title="Coming in the next build step" />
    </>
  );
}
