import type { Metadata } from 'next';
import { GapTokensView } from '@/components/app/views/GapTokensView';

export const metadata: Metadata = { title: 'Gap tokens (research prototype)' };

export default function Page() {
  return <GapTokensView />;
}
