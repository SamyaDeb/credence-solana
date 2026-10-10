import type { Metadata } from 'next';
import { RoadmapView } from '@/components/site/StaticViews';

export const metadata: Metadata = {
  title: 'Roadmap | Credence',
  description: 'Built and fork-proven, then an external audit and a capped mainnet pilot. Phase D is designed, not built.',
};

export default function Page() { return <RoadmapView />; }
