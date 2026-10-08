import type { Metadata } from 'next';
import { MarketsView } from '@/components/app/views/MarketsView';

export const metadata: Metadata = { title: 'Markets' };

export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = '' } = await searchParams;
  return <MarketsView q={q} />;
}
