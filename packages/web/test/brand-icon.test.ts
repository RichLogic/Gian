import { afterEach, describe, expect, it } from 'vitest';
import {
  applyGianIconAppearance,
  buildGianIconSvg,
  gianIconGradient,
} from '../src/brand-icon.js';

describe('accent-aware Gian icon', () => {
  afterEach(() => {
    document.querySelectorAll('link[rel~="icon"]').forEach(link => link.remove());
  });

  it('derives the same warm ember stops as the status gradient tokens', () => {
    expect(gianIconGradient('warm', 'ember')).toEqual([
      'oklch(0.64 0.18 -11)',
      'oklch(0.73 0.20 43)',
      'oklch(0.56 0.18 95)',
    ]);
  });

  it('builds the selected eye-free Voice-G mark over the accent gradient', () => {
    const svg = buildGianIconSvg('dark', 'plum');
    expect(svg).toContain('oklch(0.7 0.18 274)');
    expect(svg).toContain('oklch(0.8 0.20 328)');
    expect(svg).toContain('oklch(0.62 0.18 380)');
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).not.toMatch(/ellipse|circle|eye/i);
  });

  it('updates the browser favicon when appearance changes', () => {
    applyGianIconAppearance('light', 'azure');
    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    expect(link?.type).toBe('image/svg+xml');
    expect(link?.href).toContain('data:image/svg+xml');
    expect(decodeURIComponent(link?.href ?? '')).toContain('oklch(0.66 0.17 184)');
  });
});
