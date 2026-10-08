import type { Metadata } from 'next';
import { DemoView } from '@/components/app/views/DemoView';

export const metadata: Metadata = { title: 'Demo mode' };

export default function Page() {
  return <DemoView />;
}
