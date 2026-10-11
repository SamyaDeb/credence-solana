'use client';
// Settings: preferences kept in this browser (alerts shown, bell lead time, default slippage, the "near threshold"
// line), and the demo burner's local data. Nothing here is on-chain.
import { useState } from 'react';
import { DEFAULT_PREFS, type Prefs, usePrefs } from '@/lib/prefs';
import { useTheme } from '@/lib/theme';
import { BURNER_KEY, useSolana } from '../Providers';
import { H, KV, Note, PageHead } from '../ui';

const KINDS: [keyof Prefs['alerts'], string][] = [
  ['bell', 'The bell is coming for an uncovered position near its threshold'],
  ['cover', 'Gap cover bought'],
  ['close', 'Friday close stored'],
  ['settlement', 'Settlement price posted'],
  ['payout', 'Payout repaid into a position (or premium refunded)'],
  ['lp', 'LP ticket ready to process'],
];

export function SettingsView() {
  const [prefs, save] = usePrefs();
  const { signer, dropBurner } = useSolana();
  const [cleared, setCleared] = useState('');
  const set = (p: Partial<Prefs>) => save({ ...prefs, ...p });

  function clearLocal() {
    try {
      for (const k of ['credence.taken', 'credence.created', 'credence.alerts.read.v1', 'credence.prefs.v1']) localStorage.removeItem(k);
    } catch { /* storage off */ }
    save(DEFAULT_PREFS);
    setCleared('Local labels, read marks and preferences cleared. The demo burner key was kept.');
  }

  return (
    <>
      <PageHead title="Settings" sub="Preferences kept in this browser only." />
      <div className="cx-grid">
        <div className="cx-col">
          <Appearance />
          <section>
            <H>Alerts</H>
            <div className="cx-prefs">
              {KINDS.map(([k, label]) => (
                <label key={k} className="cx-switch">
                  <span>{label}</span>
                  <input type="checkbox" role="switch" checked={prefs.alerts[k]} onChange={() => set({ alerts: { ...prefs.alerts, [k]: !prefs.alerts[k] } })} data-testid={`pref-${k}`} />
                </label>
              ))}
            </div>
          </section>
          <section>
            <H>Weekend</H>
            <div className="cx-prefs">
              <div className="cx-field">
                <span className="cx-field-label">Alert for an uncovered position this long before the bell</span>
                <div className="cx-seg" role="group" aria-label="Bell lead time">
                  {[6, 24, 48, 96].map((h) => <button key={h} type="button" aria-pressed={prefs.bellLeadHours === h} onClick={() => set({ bellLeadHours: h })}>{h} h</button>)}
                </div>
              </div>
              <div className="cx-field">
                <span className="cx-field-label">A position is near its threshold from Debt / C′</span>
                <div className="cx-seg" role="group" aria-label="Near threshold">
                  {[0.8, 0.85, 0.9, 0.95].map((r) => <button key={r} type="button" aria-pressed={prefs.nearRatio === r} onClick={() => set({ nearRatio: r })}>{r.toFixed(2)}</button>)}
                </div>
              </div>
              <div className="cx-field">
                <span className="cx-field-label">Default slippage for Buy gap cover (max premium = quote + slippage + 0.01 USDC)</span>
                <div className="cx-seg" role="group" aria-label="Default slippage">
                  {([1, 2, 5] as const).map((x) => <button key={x} type="button" aria-pressed={prefs.slippage === x} onClick={() => set({ slippage: x })}>{x}%</button>)}
                </div>
              </div>
            </div>
          </section>
          <section>
            <H>This browser</H>
            <div className="cx-row">
              <button type="button" className="cx-btn is-ghost" onClick={clearLocal} data-testid="clear-local">Clear labels, read marks and preferences</button>
              {signer?.kind === 'burner' && <button type="button" className="cx-btn is-ghost" onClick={dropBurner}>Disconnect the demo burner</button>}
            </div>
            {cleared && <p className="cx-hint is-good" role="status">{cleared}</p>}
          </section>
        </div>
        <aside className="cx-aside">
          <KV rows={[['Stored in', 'localStorage, this browser'], ['Burner key', `${BURNER_KEY} (local keypair)`], ['On-chain', 'nothing']]} />
          <Note icon="lock">The demo burner&apos;s secret key lives only in this browser and is used only on the local fork. Clearing site data removes it.</Note>
        </aside>
      </div>
    </>
  );
}

function Appearance() {
  const [theme, setTheme] = useTheme();
  return (
    <section>
      <H>Appearance</H>
      <div className="cx-field">
        <span className="cx-field-label">Theme</span>
        <div className="cx-seg" role="group" aria-label="Theme">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <button key={t} type="button" aria-pressed={theme === t} onClick={() => setTheme(t)}>{t === 'system' ? 'Match system' : t === 'light' ? 'Light' : 'Dark'}</button>
          ))}
        </div>
      </div>
    </section>
  );
}
