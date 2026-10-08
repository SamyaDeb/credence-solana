import type { Metadata } from 'next';
import { Empty, PageHead } from '@/components/app/ui';

export const metadata: Metadata = { title: 'Underwrite' };

export default function Page() {
  return (
    <>
      <PageHead title="Underwrite" sub="The LP vault that backs every weekend's gap cover." />
      <Empty title="Coming in the next build step" />
    </>
  );
}
