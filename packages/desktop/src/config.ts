import { join } from 'node:path';

export const PROD_HOST_URL = 'http://127.0.0.1:8990';
export const DEV_HOST_URL = 'http://127.0.0.1:8991';
export const DEV_WEB_URL = 'http://127.0.0.1:5191';

export interface DesktopTargets {
  hostUrl: string;
  healthUrl: string;
  webUrl: string;
  manageLaunchAgent: boolean;
}

export interface DesktopWindowChrome {
  titleBarStyle?: 'hiddenInset';
  titleBarOverlay?: true;
}

export interface DesktopApplicationIdentity {
  name: 'Gian' | 'GianDev';
  userDataPath: string | null;
}

export interface ResolveDesktopTargetsOptions {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  env?: Readonly<Record<string, string | undefined>>;
}

function normalizeHttpOrigin(value: string, label: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use http or https`);
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an origin without a path, query, or fragment`);
  }
  return parsed.origin;
}

export function resolveDesktopTargets({
  isPackaged,
  platform,
  env = process.env,
}: ResolveDesktopTargetsOptions): DesktopTargets {
  const defaultHostUrl = isPackaged ? PROD_HOST_URL : DEV_HOST_URL;
  const hostUrl = normalizeHttpOrigin(
    env['GIAN_DESKTOP_HOST_URL'] ?? defaultHostUrl,
    'GIAN_DESKTOP_HOST_URL',
  );
  const webUrl = normalizeHttpOrigin(
    env['GIAN_DESKTOP_WEB_URL'] ?? (isPackaged ? hostUrl : DEV_WEB_URL),
    'GIAN_DESKTOP_WEB_URL',
  );
  const managementDisabled = env['GIAN_DESKTOP_DISABLE_HOST_MANAGEMENT'] === '1';

  return {
    hostUrl,
    healthUrl: `${hostUrl}/health`,
    webUrl,
    manageLaunchAgent:
      isPackaged &&
      platform === 'darwin' &&
      hostUrl === PROD_HOST_URL &&
      !managementDisabled,
  };
}

export function isTrustedDesktopUrl(
  candidate: string,
  targets: Pick<DesktopTargets, 'hostUrl' | 'webUrl'>,
): boolean {
  try {
    const origin = new URL(candidate).origin;
    return origin === targets.hostUrl || origin === targets.webUrl;
  } catch {
    return false;
  }
}

export function isSafeExternalUrl(candidate: string): boolean {
  try {
    const protocol = new URL(candidate).protocol;
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:';
  } catch {
    return false;
  }
}

export function resolveDesktopWindowChrome(
  platform: NodeJS.Platform,
): DesktopWindowChrome {
  if (platform !== 'darwin') return {};
  return {
    titleBarStyle: 'hiddenInset',
    titleBarOverlay: true,
  };
}

export function resolveDesktopApplicationIdentity(
  isPackaged: boolean,
  appDataPath: string,
): DesktopApplicationIdentity {
  return isPackaged
    ? { name: 'Gian', userDataPath: null }
    : { name: 'GianDev', userDataPath: join(appDataPath, 'GianDev') };
}
