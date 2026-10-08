import type { Metadata } from 'next';
import { Empty, PageHead } from '@/components/app/ui';

export const metadata: Metadata = { title: 'Alerts' };

export default function Page() {
  return (
    <>
      <PageHead title="Alerts" sub="The bell, your cover and your payouts, read from the chain." />
      <Empty title="Coming in the next build step" />
    </>
  );
}
