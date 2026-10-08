import type { Metadata } from 'next';
import { FaucetView } from '@/components/app/views/FaucetView';

export const metadata: Metadata = { title: 'Faucet' };

export default function Page() {
  return <FaucetView />;
}
