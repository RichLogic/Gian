export interface HealthResponse {
  ok: boolean;
  json(): Promise<unknown>;
}

export type HealthRequest = (
  url: string,
  init: {
    headers: Readonly<Record<string, string>>;
    signal: AbortSignal;
  },
) => Promise<HealthResponse>;

export interface HostReadiness {
  ready: boolean;
  checks: number;
  kickstartAttempted: boolean;
}

export interface EnsureHostAvailableOptions {
  healthUrl: string;
  manageLaunchAgent: boolean;
  kickstart?: () => Promise<void>;
  request?: HealthRequest;
  sleep?: (delayMs: number) => Promise<void>;
  maxChecks?: number;
  intervalMs?: number;
  requestTimeoutMs?: number;
}

const defaultSleep = (delayMs: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, delayMs));

export async function isHostHealthy(
  healthUrl: string,
  request: HealthRequest = fetch,
  timeoutMs = 1_500,
): Promise<boolean> {
  try {
    const response = await request(healthUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return (
      typeof body === 'object' &&
      body !== null &&
      'ok' in body &&
      body.ok === true
    );
  } catch {
    return false;
  }
}

export async function ensureHostAvailable({
  healthUrl,
  manageLaunchAgent,
  kickstart,
  request = fetch,
  sleep = defaultSleep,
  maxChecks = 16,
  intervalMs = 500,
  requestTimeoutMs = 1_500,
}: EnsureHostAvailableOptions): Promise<HostReadiness> {
  const checks = Math.max(1, maxChecks);
  let kickstartAttempted = false;

  for (let index = 0; index < checks; index += 1) {
    if (index > 0) await sleep(intervalMs);
    if (await isHostHealthy(healthUrl, request, requestTimeoutMs)) {
      return { ready: true, checks: index + 1, kickstartAttempted };
    }

    if (index === 0 && manageLaunchAgent && kickstart) {
      kickstartAttempted = true;
      try {
        await kickstart();
      } catch {
        // Poll anyway: launchd may have started the service despite a noisy exit.
      }
    }
  }

  return { ready: false, checks, kickstartAttempted };
}
