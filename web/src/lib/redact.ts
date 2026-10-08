// One redaction for every error text the browser can see (client transactions, server routes, the demo stream).
// surfpool quotes its datasource URL in errors, and RPC providers put the key in the query (`?api-key=`) or in the path
// (`/v2/<key>`, `/<token>/`), sometimes in the subdomain. Any URL that is not the local fork keeps only its scheme and
// the provider's registrable domain; key=value pairs anywhere are masked as well.
const LOCAL = /^(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d+)?$/i;

export function redact(s: string): string {
  return s
    .replace(/(https?|wss?):\/\/([^\s/"'()<>?#]+)[^\s"'()<>]*/gi, (url, scheme: string, host: string) => {
      if (LOCAL.test(host)) return url;
      const domain = host.replace(/:\d+$/, '').split('.').slice(-2).join('.');
      return `${scheme}://<rpc ${domain}>`;
    })
    .replace(/(api[-_]?key|apikey|token|key)=[^&\s"')]+/gi, '$1=***');
}
