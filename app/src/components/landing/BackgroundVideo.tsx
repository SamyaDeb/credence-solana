'use client';
import { useEffect, useRef } from 'react';
import { asset } from './content';

/** The hero's background video. `muted` is set on the element after mount (React leaves it out of the server HTML, and
 * browsers refuse unmuted autoplay); it stays paused for visitors who prefer reduced motion. */
export function BackgroundVideo() {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.muted = true;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => (mq.matches ? v.pause() : void v.play().catch(() => {}));
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  const { mp4, webm, poster } = asset.heroVideo;
  return (
    <div className="bg-video w-background-video w-background-video-atom">
      <video ref={ref} autoPlay loop muted playsInline aria-hidden="true" style={{ backgroundImage: `url("${poster}")` }}>
        <source src={mp4} type="video/mp4" />
        <source src={webm} type="video/webm" />
      </video>
    </div>
  );
}
