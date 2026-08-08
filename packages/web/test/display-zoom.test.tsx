import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getZoomPercent,
  normalizeZoomPercent,
  setZoomPercent,
  useAppZoom,
} from '../src/display-prefs.js';

describe('device zoom preference', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty('zoom');
    delete window.gianDesktop;
  });

  it('normalizes missing, out-of-range and off-step values', () => {
    expect(getZoomPercent()).toBe(100);
    expect(normalizeZoomPercent(79)).toBe(80);
    expect(normalizeZoomPercent(126)).toBe(130);
    expect(normalizeZoomPercent(151)).toBe(150);
  });

  it('uses CSS zoom in browser-only development', async () => {
    renderHook(() => useAppZoom());
    await waitFor(() => expect(document.documentElement.style.zoom).toBe('1'));
    act(() => { setZoomPercent(120); });
    await waitFor(() => expect(document.documentElement.style.zoom).toBe('1.2'));
  });

  it('syncs native Cmd +/- changes back into the stored preference', async () => {
    let notify: ((percent: number) => void) | undefined;
    const set = vi.fn(async (percent: number) => percent);
    window.gianDesktop = {
      zoom: {
        get: vi.fn(async () => 100),
        set,
        onChanged: listener => {
          notify = listener;
          return () => { notify = undefined; };
        },
      },
    };

    renderHook(() => useAppZoom());
    await waitFor(() => expect(set).toHaveBeenCalledWith(100));
    act(() => { notify?.(130); });
    await waitFor(() => expect(getZoomPercent()).toBe(130));
    await waitFor(() => expect(set).toHaveBeenCalledWith(130));
  });
});
