/** The centred tag, title and paragraph that open most sections. */
export function Heading({ tag, title, body }: { tag?: string; title: string; body?: string }) {
  return (
    <div className="center-text-holder">
      {tag && <div className="tag"><div>{tag}</div></div>}
      <div className="title-holder l"><h2 className="title">{title}</h2></div>
      {body && <div className="paragraph-holder"><p>{body}</p></div>}
    </div>
  );
}

/** Title, rule and paragraph: the text half of a split section. */
export function SplitCopy({ title, body }: { title: string; body: string }) {
  return (
    <div className="feature-grid-content-holder-2">
      <div className="fade-in-on-scroll"><h3 className="title">{title}</h3></div>
      <div className="line" />
      <div className="fade-in-on-scroll"><p>{body}</p></div>
    </div>
  );
}
