import type { ReactNode } from 'react';
import './webflow.css';
import './landing.css';

/** The marketing site. Its stylesheets are imported here only; links between it and /app are full page loads, so they
 * never reach the app. */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return children;
}
