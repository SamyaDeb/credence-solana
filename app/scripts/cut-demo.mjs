// Cuts the raw demo capture into the video: `keep` segments play in real time, `fast` segments (waiting on transactions)
// are sped up to at most their `max` seconds. Reads docs/video/raw/{demo-raw.webm,segments.json} (written by
// e2e-record/demo.spec.ts), writes docs/video/raw/demo.mp4 (H.264, 1920×1080, 30 fps). Usage: node scripts/cut-demo.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const dir = '../docs/video/raw';
const segs = JSON.parse(readFileSync(`${dir}/segments.json`, 'utf8'));
const parts = segs.map((s, i) => {
  const len = s.end - s.start;
  const speed = s.kind === 'fast' && s.max && len > s.max ? len / s.max : 1;
  return `[0:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=(PTS-STARTPTS)/${speed.toFixed(4)},fps=30[v${i}]`;
});
const filter = `${parts.join(';')};${segs.map((_, i) => `[v${i}]`).join('')}concat=n=${segs.length}:v=1:a=0[out]`;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${dir}/demo-raw.webm`, '-filter_complex', filter, '-map', '[out]',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${dir}/demo.mp4`], { stdio: 'inherit' });

let t = 0;
for (const s of segs) {
  const len = s.end - s.start;
  const out = s.kind === 'fast' && s.max && len > s.max ? s.max : len;
  console.log(`${fmt(t)}–${fmt(t + out)}  ${s.label}${out < len ? `  (${len.toFixed(0)} s sped up)` : ''}`);
  t += out;
}
console.log(`wrote ${dir}/demo.mp4 (${fmt(t)})`);
function fmt(x) { return `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`; }
