// The app's building blocks, in the style of the dashboard on the landing page (app.css, `cx-` classes). Formatting of
// on-chain integers lives in lib/format.ts; these only lay values out.
import type { ReactNode } from 'react';
import { Icon } from './Icon';

export function PageHead({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <header className="cx-page-head">
      <div>
        <h1 className="cx-page-title">{title}</h1>
        {sub && <p className="cx-page-sub">{sub}</p>}
      </div>
      {right}
    </header>
  );
}

export function H({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return <h2 className="cx-h"><span>{children}</span>{right}</h2>;
}

export type Tone = 'soft' | 'good' | 'warn' | 'bad';

export function Pill({ children, tone, testId }: { children: ReactNode; tone?: Tone; testId?: string }) {
  return <span className={`cx-pill${tone ? ` is-${tone}` : ''}`} data-testid={testId}>{children}</span>;
}

/** Marks anything simulated on the fork (clock, cheatcode balances, rewritten owners, simulated gaps). */
export function Sim({ children = 'simulated / fork', title }: { children?: ReactNode; title?: string }) {
  return <span className="cx-sim" title={title}>{children}</span>;
}

export function CardMark({ logo }: { logo?: string | null }) {
  return logo ? <img className="cx-card-mark is-token" src={logo} alt="" /> : <img className="cx-card-mark" src="/landing/mark-ink.svg" alt="" />;
}

/** The gradient card (the loan card of the dashboard design), for positions, the vault and markets. */
export function GradientCard({ logo, tag, big, label, value, pill }: { logo?: string | null; tag: ReactNode; big: ReactNode; label: string; value: ReactNode; pill?: ReactNode }) {
  return (
    <div className="cx-card">
      <div className="cx-card-top"><CardMark logo={logo} /><span className="cx-card-tag">{tag}</span></div>
      <div className="cx-card-big">{big}</div>
      <div className="cx-card-foot">
        <div><div className="cx-card-label">{label}</div><div className="cx-card-value">{value}</div></div>
        {pill}
      </div>
    </div>
  );
}

/** The big readout at the top of the grey aside. */
export function StatBlock({ label, value, chip, testId }: { label: string; value: ReactNode; chip?: ReactNode; testId?: string }) {
  return (
    <div className="cx-stat-block">
      <div>
        <div className="cx-stat-label">{label}</div>
        <div className="cx-stat-value" data-testid={testId}>{value}</div>
      </div>
      {chip && <span className="cx-chip">{chip}</span>}
    </div>
  );
}

/** A blue row: a big figure, its unit, and a note on the right. */
export function StatRow({ big, unit, sub, tag, testId }: { big: ReactNode; unit?: string; sub?: ReactNode; tag?: string; testId?: string }) {
  return (
    <div className="cx-stat-row">
      <b data-testid={testId}>{big}</b>
      {unit && <span className="cx-unit">{unit}</span>}
      <span className="cx-stat-right">
        {sub && <span className="cx-sub">{sub}</span>}
        {tag && <span className="cx-tag">{tag}</span>}
      </span>
    </div>
  );
}

export function KV({ rows, list }: { rows: [ReactNode, ReactNode][]; list?: boolean }) {
  return (
    <dl className={`cx-kv${list ? ' is-list' : ''}`}>
      {rows.map(([k, v], i) => <div key={i}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

export function Bar({ value, color }: { value: number; color?: string }) {
  return <div className="cx-bar" role="presentation"><span style={{ width: `${Math.min(100, Math.max(0, value * 100))}%`, background: color }} /></div>;
}

export function Note({ icon = 'clock', children, tone }: { icon?: string; children: ReactNode; tone?: Tone }) {
  return (
    <div className={`cx-note${tone ? ` is-${tone}` : ''}`}>
      <span className="cx-tile-icon"><Icon name={icon} size={20} strokeWidth={1.9} /></span>
      <div>{children}</div>
    </div>
  );
}

/** A tile with a figure and no action. */
export function InfoTile({ icon, title, sub, amount, testId }: { icon: string; title: string; sub: ReactNode; amount: ReactNode; testId?: string }) {
  return (
    <div className="cx-tile is-static">
      <span className="cx-tile-icon"><Icon name={icon} size={24} strokeWidth={1.9} /></span>
      <span className="cx-tile-title">{title}</span>
      <span className="cx-tile-sub">{sub}</span>
      <span className="cx-tile-amount" data-testid={testId}>{amount}</span>
    </div>
  );
}

/** What a page shows while data loads or when there is none: never a placeholder figure. */
export function Empty({ icon = 'dots', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="cx-empty">
      <span className="cx-tile-icon"><Icon name={icon} size={22} strokeWidth={1.9} /></span>
      <div><b>{title}</b>{children && <p>{children}</p>}</div>
    </div>
  );
}

/** Technical detail one click away (formulas, instruction names, invariants, sources): closed by default. */
export function Details({ summary = 'Details', children, testId }: { summary?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <details className="cx-details" data-testid={testId}>
      <summary>{summary}</summary>
      <div className="cx-details-body">{children}</div>
    </details>
  );
}

export function ErrorLine({ children, testId }: { children: ReactNode; testId?: string }) {
  return <div className="cx-error" role="alert" data-testid={testId}>{children}</div>;
}

export type Activity = { icon: string; title: string; when: string; amount: ReactNode; href?: string };

export function ActivityList({ items, compact }: { items: Activity[]; compact?: boolean }) {
  return (
    <ul className={`cx-list${compact ? ' is-compact' : ''}`} data-testid="activity">
      {items.map((a, i) => (
        <li key={i}>
          <Icon name={a.icon} size={30} strokeWidth={1.6} />
          <span className="cx-list-title">{a.title}</span>
          <span className="cx-list-when">{a.when}</span>
          <span className="cx-list-amount">{a.amount}</span>
          <span className="cx-list-more">{a.href ? <a href={a.href} aria-label="Details"><Icon name="external" size={20} /></a> : <Icon name="dots" size={22} />}</span>
        </li>
      ))}
    </ul>
  );
}
