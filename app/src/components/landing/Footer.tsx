import { footer } from './content';

// webflow.css places the footer columns by these element ids.
const BLOCK_IDS = ['7e2', '7ef', '7fa'].map((s) => `w-node-e92bf484-a605-4132-f141-4518468af${s}-468af7d9`);
const ext = (href: string) => (href.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {});

export function Footer() {
  return (
    <footer className="section">
      <div className="footer-holder">
        <div className="footer-container">
          <div className="container">
            <div className="footer-wrapper">
              <div className="footer-signup-holder">
                <div className="footer-title">{footer.title}</div>
                <p className="footer-note">Weekend gap protection for xStocks loans on Kamino. Phase 1 runs on a local mainnet fork; nothing here is deployed to mainnet.</p>
                <div className="button-holder">
                  <a href="/app" className="button form-button accent w-button">Launch App</a>
                </div>
              </div>
              <div className="footer-content">
                {footer.columns.map((col, i) => (
                  <div key={col.title} id={BLOCK_IDS[i]} className="footer-block">
                    <div className="title-small">{col.title}</div>
                    {col.links.map((l) => <a key={l.label} href={l.href} className="footer-link" {...ext(l.href)}>{l.label}</a>)}
                  </div>
                ))}
              </div>
            </div>
            <div className="footer-divider">
              {footer.credits.map((c) => (
                <div key={c.label} className="footer-copyright-holder">
                  <div className="footer-copyright-center">{c.prefix} <a href={c.href} className="dark-link" {...ext(c.href)}>{c.label}</a></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
