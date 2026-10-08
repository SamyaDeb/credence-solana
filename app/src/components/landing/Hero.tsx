import { BackgroundVideo } from './BackgroundVideo';
import { SplitCopy } from './Heading';
import { asset, companyLogos, hero, marketClock } from './content';

function LogoRow() {
  return (
    <div className="company-logo-container">
      {companyLogos.map((l, i) => (
        <div key={i} className="company-logo-wrapper-2"><img loading="lazy" src={l.src} alt={l.alt} className="company-logo-2" /></div>
      ))}
    </div>
  );
}

/** Hero, the second hero block and the ticker marquee. They share `.wrapper`: the hero's scroll motion measures
 * progress across all three (lib/landing-motion.ts). */
export function Hero() {
  const d = asset.dashboard;
  return (
    <div className="wrapper">
      <div className="section">
        <div className="hero-section-wrapper">
          <div className="container">
            <div className="hero">
              <div className="content-holder">
                <div className="animate-on-load-01"><div className="hero-heading-holder"><h1 className="hero-text">{hero.title}</h1></div></div>
                <div className="animate-on-load-02"><div className="paragraph-holder awards-holder"><p className="white-text">{hero.body}</p></div></div>
                <div className="animate-on-load-03">
                  <div className="button-holder hero-buttons">
                    <a href={hero.cta.href} className="button w-button" data-testid="launch-app">{hero.cta.label}</a>
                    <a href={hero.secondary.href} className="button w-button is-glass">{hero.secondary.label}</a>
                  </div>
                </div>
              </div>
              <div className="animate-on-load-04">
                <div className="perspective">
                  <div className="dashobard-wrapper">
                    <div className="dashboad-holder">
                      <img src={d.src} srcSet={d.srcSet} sizes={d.sizes} alt="The Credence app dashboard" className="dashobard-image" fetchPriority="high" />
                    </div>
                    <div className="blue-blur" />
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="bg-holder"><BackgroundVideo /><div className="bg-overlay" /></div>
        </div>
      </div>
      <div className="section">
        <div className="secondary-hero-holder">
          <div className="container secondary-hero"><div className="center-on-container"><SplitCopy {...marketClock} /></div></div>
        </div>
      </div>
      <div className="company-logo-wrapper">
        <div className="company-logo-holder">
          <div className="fade-in-on-scroll">
            <div className="company-logo-holder-2">
              <LogoRow /><LogoRow />
              <div className="graident-for-logos" /><div className="graident-for-logos right" />
            </div>
          </div>
          <div className="fade-in-on-scroll"><div className="container _100width"><div className="line" /></div></div>
        </div>
      </div>
    </div>
  );
}
