import type { Metadata } from 'next';
import { AboutView } from '@/components/site/StaticViews';

export const metadata: Metadata = {
  title: 'How Credence works | Credence',
  description: 'Tokenized stocks trade 24/7; the credit built on them runs on a 24/5 clock. Five layers: Gap Oracle, Liquidation Shield, Gap Cover, Monday Backstop and a yield vault.',
};

export default function Page() { return <AboutView />; }
