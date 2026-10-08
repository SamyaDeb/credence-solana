import type { Metadata } from 'next';
import { Empty, PageHead } from '@/components/app/ui';

export const metadata: Metadata = { title: 'Faucet' };

export default function Page() {
  return (
    <>
      <PageHead title="Faucet" sub="Fork funding and demo positions." />
      <Empty title="Coming in the next build step" />
    </>
  );
}
