import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ProtectView } from './ProtectView';

export const metadata: Metadata = { title: 'Protect my position' };

export default function Page() {
  return (
    <Suspense>
      <ProtectView />
    </Suspense>
  );
}
