import { asset, cta } from './content';

export function CallToAction() {
  const d = asset.dashboard;
  return (
    <div className="cta-on-footer">
      <div className="section overflow-hidden">
        <div className="container">
          <div className="cta-wrapper">
            <div className="home-wrapper">
              <div className="home-content-wrapper cta">
                <div className="title-grid">
                  <div id="w-node-_906dde2e-1a17-d076-eae1-c1231d672efb-5277456d" className="fade-in-on-scroll"><h2 className="white-text">{cta.title}</h2></div>
                  <div className="paragraph-cta">
                    <div className="fade-in-on-scroll">
                      <p className="white-paragraph">{cta.body}</p>
                      <a href={cta.button.href} className="button w-button">{cta.button.label}</a>
                    </div>
                  </div>
                </div>
                <div className="cta-dashboard-holder">
                  <div className="dashboad-holder"><img src={d.src} srcSet={d.srcSet} sizes={d.sizes} loading="lazy" alt="" className="cta-dashboard" /></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
