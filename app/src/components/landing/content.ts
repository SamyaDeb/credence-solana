// Copy and assets for the landing page: Credence on Solana, weekend gap protection for xStocks loans on Kamino. Every
// figure is from the repo's measurements (README "Measured": data/positions, data/live/s7-history.json,
// data/backtest/gap-cover-backtest.json). Copy lengths stay close to the design's so lines break where it expects.

const A = '/landing';

export type Image = { src: string; srcSet?: string; sizes?: string };

const widths = (base: string, ext: string, ws: number[], full: string, fullW: number) =>
  ws.map((w) => `${A}/${base}-${w}.${ext} ${w}w`).concat(`${A}/${full} ${fullW}w`).join(', ');

export const asset = {
  logo: `${A}/logo-credence.svg`,
  heroVideo: { mp4: `${A}/hero-video.mp4`, webm: `${A}/hero-video.webm`, poster: `${A}/hero-video-poster.jpg` },
  dashboard: {
    src: `${A}/dashboard.png`,
    srcSet: widths('dashboard', 'png', [500, 800, 1080, 1600, 2000], 'dashboard.png', 2391),
    sizes: '(max-width: 2391px) 100vw, 2391px',
  },
  arrowLeft: `${A}/arrow-left.svg`,
  arrowRight: `${A}/arrow-right.svg`,
  handWatch: { src: `${A}/hand-watch.png`, srcSet: `${A}/hand-watch-500.png 500w, ${A}/hand-watch.png 682w`, sizes: '(max-width: 682px) 100vw, 682px' },
  watchApp: { src: `${A}/watch-app.jpg`, srcSet: `${A}/watch-app-500.jpg 500w, ${A}/watch-app.jpg 512w`, sizes: '(max-width: 512px) 100vw, 512px' },
};

const featureImage = (n: 1 | 2): Image => ({
  src: `${A}/feature-0${n}.jpg`,
  srcSet: widths(`feature-0${n}`, 'jpg', [500, 800, 1080, 1600], `feature-0${n}.jpg`, 1710),
  sizes: '(max-width: 1710px) 100vw, 1710px',
});

const sky: Image = { src: `${A}/sky.avif`, srcSet: widths('sky', 'avif', [500, 800, 1080], 'sky.avif', 2880), sizes: '(max-width: 2880px) 100vw, 2880px' };

export const navLinks = [
  { label: 'How it works', href: '#features' },
  { label: 'Products', href: '#explore' },
  { label: 'The gap', href: '#why-us' },
  { label: 'Mainnet view', href: '/mainnet' },
  { label: 'Proof', href: '/proof' },
  { label: 'GitHub', href: 'https://github.com/SamyaDeb/credence-solana' },
];

export const navCta = { label: 'Launch App', href: '/app' };

export const hero = {
  title: 'Borrow on xStocks. Keep Your Weekend.',
  body: 'Weekend gap protection for xStocks loans on Kamino. Bought before the Friday bell, paid into your position after the Monday open.',
  cta: { label: 'Launch App', href: '/app' },
  secondary: { label: 'How it works', href: '#features' },
};

export const marketClock = {
  title: 'The Price Kamino Lends On Stops at the Bell',
  body: "xStocks trade all weekend, but Kamino's SPYx and NVDAx price did not change once between Friday's close and Monday morning, six weekends in a row. The gap lands all at once, before you can react.",
};

/** The marquee: the xStocks Credence covers on Kamino. */
export const companyLogos = ['SPY', 'NVDA'].flatMap((t) => [t, t, t, t]).map((t) => ({ src: `${A}/ticker-${t.toLowerCase()}.svg`, alt: t }));

export const featuresHeading = {
  tag: 'The weekend risk layer',
  title: 'Price the Gap, Pay It, Then Prevent It',
  body: "Tokenized stocks trade 24/7; the credit built on them still runs on a 24/5 clock. Each layer below says where it stands today.",
};

/** Where each layer stands. Update as layers ship; never mark a layer live on mainnet before it is. */
export const STATUS = {
  oracle: 'Live mainnet readings',
  cover: 'Fork-proven',
  vault: 'Fork-proven',
  pricing: 'On-chain, backtested',
  shield: 'In build',
  backstop: 'In build',
} as const;

/** Delays are the per-card slide-in delays (ms). */
export const features = [
  { icon: `${A}/icon-06.svg`, title: 'Gap Oracle', status: STATUS.oracle, body: "Kamino's own Scope price at the close, the 24/7 xStock price, and the gap Kamino does not see yet.", delay: 150 },
  { icon: `${A}/icon-03.svg`, title: 'Gap Cover', status: STATUS.cover, body: 'Bought before the Friday bell in one transaction; after the open it repays exactly what brings the loan back to its threshold, into the position.', delay: 250 },
  { icon: `${A}/icon-01.svg`, title: 'LP Vault', status: STATUS.vault, body: 'Underwriters hold the gap in one USDC vault, sized so the worst of 256 joint stress weekends fits in half its equity.', delay: 350 },
  { icon: `${A}/icon-05.svg`, title: 'Priced From History', status: STATUS.pricing, body: 'Premiums come from ten years of weekend gaps per ticker, priced on-chain over a 3,000-scenario set.', delay: 150 },
  { icon: `${A}/icon-04.svg`, title: 'Liquidation Shield', status: STATUS.shield, body: "Repays into the position before Kamino's Monday pre-market move, sized from the 24/7 price while Kamino's is frozen.", delay: 250 },
  { icon: `${A}/icon-02.svg`, title: 'Monday Backstop', status: STATUS.backstop, body: 'Pre-committed liquidity liquidates what still breaks at the move and resells it by Dutch auction, at fair prices.', delay: 350 },
];

export const whyUsHeading = {
  tag: 'The gap',
  title: 'Weekend Risk, Measured on Mainnet',
  body: '1,374 Kamino positions borrow $6.84M of USDC against the eight covered xStocks (scan Oct 9). 895 of them, $1.96M of debt, fit single-asset cover; 1,230 with multi-collateral and PYUSD, 2,427 with Jupiter Lend.',
};

export const whyUs = [
  {
    title: 'Frozen From Friday to Monday',
    body: "Kamino's xStock price comes from Chainlink and Pyth through Scope. Chainlink's 24/5 streams publish nothing at weekends, so SPYx and NVDAx held still six weekends running, then moved in Monday pre-market.",
    image: featureImage(2),
    caption: 'Six weekends, one price',
    imageFirst: false,
  },
  {
    title: 'Underwriters Paid to Hold the Gap',
    body: 'A ten-year backtest of a model book returns 2.2% a year on LP equity, with a loss ratio of 41% and a worst weekend of −3.9% of equity (Jan 2019, NVDA −13.6%).',
    image: featureImage(1),
    caption: 'Backtested 2016–2026',
    imageFirst: true,
  },
];

export const explore = {
  tag: 'Explore',
  title: 'Three Ways to Use Credence',
  body: 'Cover a Kamino loan for the weekend, underwrite the gap, or read the Gap Oracle. Every number comes from the chain or a measured file.',
};

export type Slide = { icon: string; title: string; body: string; light?: boolean; image?: Image };

const slideSet: Slide[] = [
  { icon: `${A}/icon-08.svg`, title: 'Cover Your Kamino Loan', body: 'Keep your SPYx or NVDAx exposure through the weekend. See what a −5, −8 or −12% open does to your position, then cover it.', image: sky },
  { icon: `${A}/icon-07.svg`, title: 'Underwrite the Gap', body: 'Deposit USDC into the vault. Premiums are earned when each weekend settles; deposits and withdrawals wait for it.', light: true },
  { icon: `${A}/icon-09.svg`, title: 'Watch the Gap Oracle', body: "Friday's close, Kamino's frozen price, the 24/7 xStock price and the implied gap, read from mainnet every 10 seconds." },
];

/** The design repeats the three cards three times. */
export const slides: Slide[] = [...slideSet, ...slideSet, ...slideSet];

export const appleWatch = {
  title: 'Before the Bell, Not After',
  body: 'Your positions, the loss at each gap and the premium, while there is still time to cover.',
  cta: { label: 'Check my positions', href: '/app/borrow' },
};

export const tabsHeading = {
  title: 'One Weekend, Step by Step',
  body: 'From the Friday bell to the Monday payout, every step is a transaction on Solana, checked by the program.',
};

export const tabs = [
  { label: 'The Bell', image: `${A}/tab-alerts.svg`, body: 'Sales close 15 minutes before Friday\'s 4 PM ET close. After the bell, no policy can be written (INV-3).' },
  { label: 'The Close', image: `${A}/tab-transfers.svg`, body: "At 4 PM the keeper stores the Friday close from Kamino's own Scope price, the price klend liquidates on." },
  { label: 'The Open', image: `${A}/tab-savings.svg`, body: 'After Monday\'s open, the settlement price is read inside a five-minute window (INV-4), never chosen afterwards.' },
  { label: 'The Payout', image: `${A}/tab-setup.svg`, body: 'Anyone can settle a policy: the payout is repaid into the Kamino obligation by a vault-signed CPI; the rest goes to the owner.' },
];

export const cta = {
  title: 'Keep Your xStocks. Cover the Weekend.',
  body: 'Phase 1 runs on a local mainnet fork with real Kamino state. Open the app and walk a weekend end to end.',
  button: { label: 'Launch App', href: '/app' },
};

export const footer = {
  title: 'Credence on Solana',
  links: [
    { label: 'GitHub', href: 'https://github.com/SamyaDeb/credence-solana' },
  ],
  columns: [
    { title: 'App', links: [{ label: 'Overview', href: '/app' }, { label: 'Borrow', href: '/app/borrow' }, { label: 'Underwrite', href: '/app/underwrite' }, { label: 'Risk', href: '/app/risk' }] },
    { title: 'Protocol', links: [{ label: 'How it works', href: '#features' }, { label: 'The gap', href: '#why-us' }, { label: 'Products', href: '#explore' }, { label: 'The weekend', href: '#bell' }] },
    { title: 'Built with', links: [{ label: 'Solana', href: 'https://solana.com' }, { label: 'Kamino', href: 'https://kamino.finance' }, { label: 'xStocks', href: 'https://xstocks.com' }, { label: 'Anchor', href: 'https://www.anchor-lang.com' }] },
  ],
  credits: [{ prefix: 'Built on', label: 'SOLANA', href: 'https://solana.com' }],
};
