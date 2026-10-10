import type { Metadata } from 'next';
import { UnlockView } from '@/components/site/UnlockView';
import { loadSnapshot } from '@/lib/site/load';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Credit unlock | Credence',
  description: 'How much more credit full weekend gap protection would allow on Kamino and Jupiter Lend, at what cost, and with how much capital. What cover would allow, not measured demand.',
};

export default function Page() {
  return <UnlockView data={{ unlock: loadSnapshot().unlock }} now={Date.now()} />;
}
