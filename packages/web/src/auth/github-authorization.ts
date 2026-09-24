import type { GitHubDeviceAuthorization, RemoteSettingsSnapshot } from '@gian/shared';

type Role = 'host' | 'controller';
type Account = NonNullable<RemoteSettingsSnapshot['account']>;
export interface GitHubAuthorizationState {
  id: number;
  serverUrl: string;
  authorization: GitHubDeviceAuthorization | null;
  phase: 'checking' | 'waiting' | 'error';
  error: string | null;
  retrying: boolean;
}

let sequence = 0;
let state: GitHubAuthorizationState | null = null;
let active: { id: number; abort: AbortController; retry?: () => void } | null = null;
const listeners = new Set<() => void>();
export const getGitHubAuthorization = () => state;
export function subscribeGitHubAuthorization(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function publish(next: GitHubAuthorizationState | null) {
  state = next;
  for (const listener of listeners) listener();
}
export function cancelGitHubAuthorization(id?: number): void {
  if (active && (id === undefined || active.id === id)) active.abort.abort();
}
export function retryGitHubAuthorization(id: number): void {
  if (active?.id === id) active.retry?.();
}

class Unavailable extends Error {
  constructor(readonly delay = 5) { super('network'); }
}
function cancelled(): Error { return new Error('cancelled'); }
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    const abort = () => { clearTimeout(timer); reject(cancelled()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
/** AbortSignal.any without the platform dependency (jsdom predates it). */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) { controller.abort(); return controller.signal; }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

/** App-wide identity confirmation. The caller retains its unsent intent in
 * memory and resumes only after success; no enrollment/pairing mutation is replayed. */
export async function authorizeRemoteAccount(serverUrl: string, role: Role = 'host', options: {
  fetchFn?: typeof fetch; signal?: AbortSignal;
} = {}): Promise<void> {
  const url = new URL(serverUrl);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(role === 'host' && loopback && url.protocol === 'http:'))) throw new Error('invalid_url');
  if (options.signal?.aborted) throw cancelled();
  if (active) throw new Error('authorization_busy');
  const attempt = { id: ++sequence, abort: new AbortController(), retry: undefined as (() => void) | undefined };
  active = attempt;
  const signal = attempt.abort.signal;
  const abortFromCaller = () => attempt.abort.abort();
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const prefix = role === 'host' ? '/api/remote/account' : '/api/remote/controller/account';
  const show = (patch: Partial<GitHubAuthorizationState>) => {
    if (!signal.aborted && active === attempt) publish({ id: attempt.id, serverUrl: url.origin,
      phase: 'checking', authorization: null, error: null, retrying: false, ...patch });
  };
  const request = async (operation: 'start' | 'poll'): Promise<Account> => {
    let response: Response;
    try {
      response = await fetchFn(`${prefix}/${operation}`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ server_url: url.origin }),
        signal: anySignal([signal, AbortSignal.timeout(15_000)]),
      });
    } catch { if (signal.aborted) throw cancelled(); throw new Unavailable(); }
    if (signal.aborted) throw cancelled();
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      const delay = Number(response.headers.get('retry-after'));
      throw new Unavailable(Number.isFinite(delay) ? Math.min(60, Math.max(5, delay)) : 5);
    }
    if (!response.ok) throw new Error('verification_failed');
    const result = await response.json() as RemoteSettingsSnapshot;
    if (signal.aborted) throw cancelled();
    const account = result.account;
    if (!account || account.server_url !== url.origin || !['pending', 'authorized', 'denied', 'expired'].includes(account.status)
      || !Number.isFinite(account.expires_at)) throw new Error('invalid_response');
    return account;
  };
  try {
    for (;;) {
      if (signal.aborted) throw cancelled();
      try {
        let account = await request('start');
        if (account.status === 'authorized' && account.expires_at > Date.now()) return;
        if (account.status !== 'pending' || !account.user_code || account.verification_uri !== 'https://github.com/login/device') {
          throw new Error(account.status === 'denied' ? 'denied' : 'expired');
        }
        const authorization = { userCode: account.user_code, verificationUri: account.verification_uri,
          expiresAt: new Date(account.expires_at).toISOString() };
        const deadline = account.expires_at;
        let interval = Math.min(60, Math.max(5, account.interval_seconds ?? 5));
        show({ phase: 'waiting', authorization });
        for (;;) {
          if (deadline <= Date.now()) throw new Error('expired');
          await pause(Math.min(interval * 1000, deadline - Date.now()), signal);
          if (deadline <= Date.now()) throw new Error('expired');
          try { account = await request('poll'); }
          catch (error) {
            if (!(error instanceof Unavailable)) throw error;
            interval = Math.min(60, Math.max(interval * 2, error.delay));
            show({ phase: 'waiting', authorization, retrying: true });
            continue;
          }
          if (account.status === 'authorized' && account.expires_at > Date.now()) return;
          if (account.status !== 'pending') throw new Error(account.status === 'denied' ? 'denied' : 'expired');
          interval = Math.min(60, Math.max(5, account.interval_seconds ?? interval));
          show({ phase: 'waiting', authorization });
        }
      } catch (error) {
        if (signal.aborted) throw cancelled();
        const code = error instanceof Unavailable ? 'network' : error instanceof Error
          && ['denied', 'expired', 'verification_failed'].includes(error.message) ? error.message : 'invalid_response';
        show({ phase: 'error', error: code });
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) { reject(cancelled()); return; }
          const abort = () => { attempt.retry = undefined; reject(cancelled()); };
          attempt.retry = () => { signal.removeEventListener('abort', abort); attempt.retry = undefined; resolve(); };
          signal.addEventListener('abort', abort, { once: true });
        });
        show({ phase: 'checking' });
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', abortFromCaller);
    if (active === attempt) { active = null; publish(null); }
  }
}
