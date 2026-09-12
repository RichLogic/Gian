/** Keep one-time QR grants out of request URLs, referrers and browser history. */
export function readPairingLink(href: string): { nonce: string | undefined; cleanUrl: string } {
  const url = new URL(href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const values = [...fragment.getAll('nonce'), ...url.searchParams.getAll('nonce')];
  fragment.delete('nonce');
  url.searchParams.delete('nonce');
  url.hash = fragment.toString();
  const candidate = values[0];
  const nonce = values.length === 1 && candidate && /^[-_a-zA-Z0-9]{16,256}$/.test(candidate)
    && (url.pathname === '/pair' || url.pathname === '/') ? candidate : undefined;
  return { nonce, cleanUrl: url.pathname + url.search + url.hash };
}
