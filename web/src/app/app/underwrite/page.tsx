import type { Metadata } from 'next';
import { UnderwriteView } from '@/components/app/views/UnderwriteView';

export const metadata: Metadata = { title: 'Underwrite' };

export default function Page() {
  return <UnderwriteView />;
}
