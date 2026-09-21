/** Parse a one-time QR grant without putting it in a request URL. */
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

/** Keep an unclaimed invitation transferable from a scanner to a browser.
 * Legacy query grants move to the fragment immediately; confirmation/cancel
 * clears the fragment through dismiss(), before any claim is submitted.
 */
export function preparePairingLink(href: string, replaceUrl: (url: string) => void) {
  const { nonce, cleanUrl } = readPairingLink(href);
  const entry = new URL(cleanUrl, href);
  if (nonce) {
    const fragment = new URLSearchParams(entry.hash.slice(1));
    fragment.set('nonce', nonce);
    entry.hash = fragment.toString();
  }
  const entryUrl = entry.pathname + entry.search + entry.hash;
  const original = new URL(href);
  if (original.pathname + original.search + original.hash !== entryUrl) replaceUrl(entryUrl);
  let dismissed = false;
  return {
    nonce,
    dismiss() {
      if (dismissed || !nonce) return;
      dismissed = true;
      replaceUrl(cleanUrl);
    },
  };
}
