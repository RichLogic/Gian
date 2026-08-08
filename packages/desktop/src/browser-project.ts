import { posix } from 'node:path';

export interface BrowserProjectSite {
  workingTreeId: string;
  root: string;
  entry: string;
}

export function createBrowserProjectSite(
  workingTreeId: string,
  inputPath: string,
): BrowserProjectSite | null {
  const path = normalizeRelativePath(inputPath);
  if (!path) return null;
  const root = posix.dirname(path);
  return {
    workingTreeId,
    root: root === '.' ? '' : root,
    entry: posix.basename(path),
  };
}

export function browserProjectUrl(siteId: string, entry: string): string {
  const encoded = entry.split('/').map(encodeURIComponent).join('/');
  return `gian-browser://${siteId}/${encoded}`;
}

/** Resolve a custom-origin request inside the HTML file's directory. Absolute
 * site URLs (/assets/app.js) remain inside that root, and traversal can never
 * escape it. The Host performs its own working-tree boundary check as a
 * second line of defence. */
export function resolveBrowserProjectPath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;

  const directoryRequest = decoded === '' || decoded.endsWith('/');
  const relative = decoded.replace(/^\/+/, '') || 'index.html';
  const normalized = normalizeRelativePath(directoryRequest && relative !== 'index.html'
    ? `${relative}/index.html`
    : relative);
  if (!normalized) return null;

  const full = posix.normalize(root ? `${root}/${normalized}` : normalized);
  if (!root) return normalizeRelativePath(full);
  if (full !== root && !full.startsWith(`${root}/`)) return null;
  return full;
}

function normalizeRelativePath(input: string): string | null {
  if (!input || input.startsWith('/') || input.includes('\0') || input.includes('\\')) return null;
  const normalized = posix.normalize(input);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

/** Baseline for authored project pages. It permits ordinary static-site
 * resources plus HTTPS and localhost development services, while keeping
 * plugins, object embeds and arbitrary non-local cleartext origins blocked. */
export const BROWSER_PROJECT_CSP = [
  "default-src 'self' data: blob: https: http://localhost:* http://127.0.0.1:* http://[::1]:*",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: http://localhost:* http://127.0.0.1:* http://[::1]:*",
  "style-src 'self' 'unsafe-inline' https: http://localhost:* http://127.0.0.1:* http://[::1]:*",
  "img-src 'self' data: blob: https: http://localhost:* http://127.0.0.1:* http://[::1]:*",
  "font-src 'self' data: https: http://localhost:* http://127.0.0.1:* http://[::1]:*",
  "connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:* http://[::1]:* ws://localhost:* ws://127.0.0.1:* ws://[::1]:*",
  "media-src 'self' data: blob: https: http://localhost:* http://127.0.0.1:* http://[::1]:*",
  "worker-src 'self' blob:",
  "frame-src 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:*",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:*",
].join('; ');
