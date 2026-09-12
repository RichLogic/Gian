export interface BrowserTransientPopupOptions {
  width: number;
  height: number;
}

function featureMap(value: string): Map<string, string> {
  const features = new Map<string, string>();
  for (const part of value.split(',')) {
    const [rawKey, rawValue = 'yes'] = part.trim().split('=', 2);
    const key = rawKey?.trim().toLowerCase();
    if (key) features.set(key, rawValue.trim().toLowerCase());
  }
  return features;
}

function boundedDimension(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
}

export function transientBrowserPopupOptions(input: {
  url: string;
  features: string;
  disposition: string;
}): BrowserTransientPopupOptions | null {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (input.disposition !== 'new-window' && input.disposition !== 'default') return null;
  const features = featureMap(input.features);
  const explicitlyPopup = ['yes', 'true', '1', ''].includes(features.get('popup') ?? 'no');
  const sizedPopup = features.has('width') && features.has('height');
  if (!explicitlyPopup && !sizedPopup) return null;
  return {
    width: boundedDimension(features.get('width'), 520, 320, 900),
    height: boundedDimension(features.get('height'), 680, 240, 900),
  };
}
