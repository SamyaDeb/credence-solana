import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/app/AppShell';
import { Providers } from '@/components/app/Providers';
import './app.css';

export const metadata: Metadata = { title: { default: 'Credence App', template: '%s · Credence' } };

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <AppShell>{children}</AppShell>
    </Providers>
  );
}
