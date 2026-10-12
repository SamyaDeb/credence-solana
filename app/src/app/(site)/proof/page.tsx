import type { Metadata } from 'next';
import { ProofView } from '@/components/site/ProofView';
import { loadDevnet } from '@/lib/site/devnet';
import { loadSnapshot } from '@/lib/site/load';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Proof: tests, audit, curator books | Credence',
  description: 'Fork-proven against Kamino’s and Jupiter Lend’s real programs; nothing on mainnet; audit first. Test counts, the internal audit summary and the curator-book demo.',
};

export default async function Page() {
  const [s, devnet] = await Promise.all([loadSnapshot(), loadDevnet()]);
  return <ProofView data={{ proof: s.proof, books: s.books }} devnet={devnet} now={Date.now()} />;
}
