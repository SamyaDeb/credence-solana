// The wording rules for the public pages, as code: "gap protection", "risk layer", "fork-proven", "computed off-chain from
// mainnet data". Never "insurance", "live on mainnet", "live feed" or a demand claim. The two disclosures that must name
// the banned word ("not insurance", "not measured demand") are the only allowed uses.
const ALLOWED = [/\bnot insurance\b/gi, /\bnot measured demand\b/gi, /\bnot live\b/gi];
const BANNED: [string, RegExp][] = [
  ['insurance', /\binsurance\b/i],
  ['live on mainnet', /\blive on mainnet\b/i],
  ['live feed', /\blive feed\b/i],
  ['demand', /\bdemand\b/i],
];

/** The banned phrases found in `text` after the allowed disclosures are removed. */
export function findUnsafe(text: string): string[] {
  const rest = ALLOWED.reduce((t, a) => t.replace(a, ' '), text.replace(/\s+/g, ' '));
  return BANNED.filter(([, re]) => re.test(rest)).map(([name]) => name);
}
