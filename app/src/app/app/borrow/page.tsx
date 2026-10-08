import type { Metadata } from 'next';
import { BorrowView } from '@/components/app/views/BorrowView';

export const metadata: Metadata = { title: 'Borrow' };

export default function Page() {
  return <BorrowView />;
}
