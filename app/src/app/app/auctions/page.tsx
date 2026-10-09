import type { Metadata } from 'next';
import { BackstopView } from '@/components/app/views/BackstopView';

export const metadata: Metadata = { title: 'Auctions' };

export default function Page() {
  return <BackstopView />;
}
