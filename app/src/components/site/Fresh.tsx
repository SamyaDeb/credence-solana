import { freshness } from '@/lib/site/fresh';

/** The as-of line every published number carries: fresh within its bound, otherwise stamped stale. */
export function Fresh({ asOf, now, bound, source }: { asOf: string | null | undefined; now: number; bound: number; source: string }) {
  const f = freshness(asOf, now, bound);
  return (
    <p className={`sx-fresh ${f.state === 'stale' ? 'is-stale' : ''}`} data-testid="fresh" data-state={f.state}>
      <span className="sx-chip">{f.state === 'stale' ? 'Stale' : 'Snapshot'}</span> {f.label.replace(/^Stale: /, '').replace(/\.$/, '')}. <span className="sx-src">Source: {source}.</span>
    </p>
  );
}

export function Missing({ what, how }: { what: string; how: string }) {
  return <p className="sx-note" role="note" data-testid="missing">No {what} in this build ({how}).</p>;
}
