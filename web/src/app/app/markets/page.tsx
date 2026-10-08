import type { Metadata } from 'next';
import { Empty, PageHead } from '@/components/app/ui';

export const metadata: Metadata = { title: 'Markets' };

export default function Page() {
  return (
    <>
      <PageHead title="Markets" sub="SPYx, QQQx and NVDAx on Kamino's xStocks Market, priced for the coming weekend." />
      <Empty title="Coming in the next build step" />
    </>
  );
}
