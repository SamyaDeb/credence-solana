'use client';
import { useEffect } from 'react';
import { startLandingMotion } from '@/lib/landing-motion';

/** Starts the landing page's motion; renders nothing. */
export function Motion() {
  useEffect(() => {
    const root = document.documentElement;
    if (!root.classList.contains('ix')) return; // reduced motion: static page
    try {
      return startLandingMotion();
    } catch (e) {
      root.classList.remove('ix'); // never leave content hidden in its start state
      console.error('landing motion failed to start', e);
    }
  }, []);
  return null;
}
