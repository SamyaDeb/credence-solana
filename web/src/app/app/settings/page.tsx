import type { Metadata } from 'next';
import { Empty, PageHead } from '@/components/app/ui';

export const metadata: Metadata = { title: 'Settings' };

export default function Page() {
  return (
    <>
      <PageHead title="Settings" sub="Preferences kept in this browser." />
      <Empty title="Coming in the next build step" />
    </>
  );
}
