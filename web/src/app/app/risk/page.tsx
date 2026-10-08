import type { Metadata } from 'next';
import { Empty, PageHead } from '@/components/app/ui';

export const metadata: Metadata = { title: 'Risk' };

export default function Page() {
  return (
    <>
      <PageHead title="Risk" sub="The Gap Oracle: Friday's close, Kamino's frozen price and the 24/7 xStock price." />
      <Empty title="Coming in the next build step" />
    </>
  );
}
