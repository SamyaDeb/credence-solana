import type { Metadata } from 'next';
import { AccountView } from '@/components/app/views/AccountView';

export const metadata: Metadata = { title: 'Account' };

export default function Page() {
  return <AccountView />;
}
