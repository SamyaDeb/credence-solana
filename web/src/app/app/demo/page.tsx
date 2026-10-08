import type { Metadata } from 'next';
import { Empty, PageHead } from '@/components/app/ui';

export const metadata: Metadata = { title: 'Demo mode' };

export default function Page() {
  return (
    <>
      <PageHead title="Demo mode" sub="Friday close, Monday open with a gap, settlement into your position." />
      <Empty title="Coming in the next build step" />
    </>
  );
}
