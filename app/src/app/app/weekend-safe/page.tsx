import type { Metadata } from 'next';
import { WeekendSafeView } from '@/components/app/views/WeekendSafeView';

export const metadata: Metadata = { title: 'Weekend-safe market' };

export default function Page() {
  return <WeekendSafeView />;
}
