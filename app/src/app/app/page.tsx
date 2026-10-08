import type { Metadata } from 'next';
import { OverviewView } from '@/components/app/views/OverviewView';

export const metadata: Metadata = { title: 'Overview' };

export default function Page() {
  return <OverviewView />;
}
