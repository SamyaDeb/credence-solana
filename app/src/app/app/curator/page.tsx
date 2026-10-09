import type { Metadata } from 'next';
import { CuratorView } from '@/components/app/views/CuratorView';

export const metadata: Metadata = { title: 'Curator' };

export default function Page() {
  return <CuratorView />;
}
