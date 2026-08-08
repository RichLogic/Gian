/** Address-bar normalization. This is intentionally a URL bar, not a search
 * box: ambiguous text fails visibly instead of being sent to a third party. */
export function normalizeBrowserAddress(input: string): string | null {
  const value = input.trim();
  if (!value) return null;

  let candidate = value;
  if (/^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0)(?::\d+)?(?:[/?#]|$)/i.test(value)) {
    candidate = `http://${value}`;
  } else if (/^\[::1\](?::\d+)?(?:[/?#]|$)/i.test(value)) {
    candidate = `http://${value}`;
  } else if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    candidate = `https://${value}`;
  }

  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'gian-browser:') {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
