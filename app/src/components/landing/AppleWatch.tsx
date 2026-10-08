import { appleWatch, asset } from './content';

export function AppleWatch() {
  const { handWatch: h, watchApp: w } = asset;
  return (
    <div className="section apple-watch-section" id="bell">
      <div className="container">
        <div className="spacing">
          <div className="hand-watch-holder">
            <div id="w-node-f7707f47-b0a6-057b-77c0-4a246dfdb7df-c0ca8b6f" className="center-hand-text">
              <div className="content"><div className="fade-in-on-scroll"><div className="hero-text---bold watch-text">{appleWatch.title}</div></div></div>
            </div>
            <div className="hand-holder">
              <div className="hand-overlay" />
              <div className="hand-container">
                <img src={h.src} srcSet={h.srcSet} sizes={h.sizes} alt="" loading="lazy" className="hand-with-watch-image" />
                <div className="watch-app-image-holder"><img src={w.src} srcSet={w.srcSet} sizes={w.sizes} alt="" loading="lazy" className="watch-app-image" /></div>
              </div>
            </div>
          </div>
          <div id="w-node-afb0e9af-2d61-c065-0c01-bbbd66753935-c0ca8b6f" className="center-text-holder">
            <div className="content">
              <div className="fade-in-on-scroll"><div className="paragraph-holder"><h4 className="white-text-2">{appleWatch.body}</h4></div></div>
              <div className="button-holder-2"><div className="fade-in-on-scroll"><a href={appleWatch.cta.href} className="button w-button">{appleWatch.cta.label}</a></div></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
