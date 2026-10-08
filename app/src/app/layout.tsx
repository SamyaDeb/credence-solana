import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Header } from '@/components/header';
import { Providers } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Credence: weekend gap protection',
  description: 'Gap protection for Kamino xStocks positions, paid into your position after the open.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <Header />
          <main><div className="wrap">{children}</div></main>
        </Providers>
      </body>
    </html>
  );
}
