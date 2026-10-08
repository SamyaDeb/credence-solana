import type { Metadata, Viewport } from 'next';
import { Inter, Manrope, Outfit } from 'next/font/google';
import type { ReactNode } from 'react';

const manrope = Manrope({ subsets: ['latin'], variable: '--font-manrope', display: 'swap' });
const inter = Inter({ subsets: ['latin'], style: ['normal', 'italic'], variable: '--font-inter', display: 'swap' });
/** The app's typeface. */
const outfit = Outfit({ subsets: ['latin'], variable: '--font-outfit', display: 'swap' });

export const metadata: Metadata = {
  title: 'Credence: weekend gap protection on Solana',
  description: 'Weekend gap protection for xStocks loans on Kamino, bought before the Friday bell and paid into your position after the Monday open.',
  icons: { icon: '/landing/favicon.png', apple: '/landing/webclip.png' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

/** Before first paint: `ix` holds the landing's animated elements in their start state until lib/landing-motion.ts
 * runs; visitors who prefer reduced motion get the static page. */
const boot = `(function(d,w){if(!w.matchMedia("(prefers-reduced-motion: reduce)").matches)d.documentElement.classList.add("ix");})(document,window);`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${manrope.variable} ${inter.variable} ${outfit.variable}`} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: boot }} /></head>
      <body>{children}</body>
    </html>
  );
}
