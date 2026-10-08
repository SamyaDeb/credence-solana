import type { Metadata } from 'next';
import { AlertsView } from '@/components/app/views/AlertsView';

export const metadata: Metadata = { title: 'Alerts' };

export default function Page() {
  return <AlertsView />;
}
