import { Heading } from './Heading';
import { features, featuresHeading } from './content';

export function Features() {
  return (
    <div className="section" id="features">
      <div className="container">
        <div className="spacing">
          <Heading {...featuresHeading} />
          <div className="_4-col-grid">
            {features.map((f) => (
              <div key={f.title} className="simple-feature-container" data-ix="slideInBottom" data-ix-delay={f.delay}>
                <div className="simple-feature-icon-holder"><img src={f.icon} loading="lazy" alt="" className="simple-feature-icon" /></div>
                <div className="simple-feature-content"><span className="layer-status">{f.status}</span><h5 className="title">{f.title}</h5><p className="paragraph-small">{f.body}</p></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
