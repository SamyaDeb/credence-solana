import type { Metadata } from 'next';
import { DisclosureView } from '@/components/site/StaticViews';

export const metadata: Metadata = {
  title: 'Disclosure | Credence',
  description: 'Not live, not insurance. Prior work, data licence and the notice for US persons.',
};

export default function Page() { return <DisclosureView />; }
