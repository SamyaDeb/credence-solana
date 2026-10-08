import { Heading, SplitCopy } from './Heading';
import { whyUs, whyUsHeading } from './content';

// webflow.css places the grid cells by these element ids (on tablet the second row's copy moves above its image).
const IDS = [
  { copy: 'w-node-e5b4a9f2-978a-d998-ece6-b03bfedc8d69-c0ca8b6f', image: 'w-node-e5b4a9f2-978a-d998-ece6-b03bfedc8d71-c0ca8b6f' },
  { copy: 'w-node-e5b4a9f2-978a-d998-ece6-b03bfedc8d7a-c0ca8b6f', image: 'w-node-e5b4a9f2-978a-d998-ece6-b03bfedc8d76-c0ca8b6f' },
];

export function WhyUs() {
  return (
    <div className="section" id="why-us">
      <div className="container">
        <div className="spacing">
          <Heading {...whyUsHeading} />
          <div className="new-features-holder">
            {whyUs.map((row, i) => {
              const copy = <div key="c" id={IDS[i].copy} className="feature-grid-content"><SplitCopy title={row.title} body={row.body} /></div>;
              const image = (
                <div key="i" id={IDS[i].image} className="feature-graphic-holder" data-ix={row.imageFirst ? 'slideInLeft' : 'slideInRight'} data-ix-delay={250}>
                  <div className="feature-image-container">
                    <img src={row.image.src} srcSet={row.image.srcSet} sizes={row.image.sizes} alt="" loading="lazy" className="feature-image-full" />
                    <div className="feature-overlay" data-ix="slideInBottom" data-ix-delay={700}>
                      <div className="content-touch"><h4 className="white-text">{row.caption}</h4></div>
                    </div>
                  </div>
                </div>
              );
              return <div key={row.title} className="w-layout-grid new-features-grid">{row.imageFirst ? [image, copy] : [copy, image]}</div>;
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
