import type { Metadata } from 'next';
import { WeekendView } from '@/components/site/WeekendView';
import { loadSnapshot } from '@/lib/site/load';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'The real weekend, Oct 9–12 | Credence',
  description: 'A read-only model on real data: what the Liquidation Shield would have done and what policies would have paid over the real weekend of October 9–12, 2026.',
};

export default function Page() {
  return <WeekendView data={{ weekend: loadSnapshot().weekend }} now={Date.now()} />;
}
