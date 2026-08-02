import { afterEach, describe, expect, it } from 'vitest';
import {
  applyGianIconAppearance,
  buildGianIconSvg,
  GIAN_MACOS_ICON_SCALE,
  gianIconGradient,
} from '../src/brand-icon.js';

describe('accent-aware Gian icon', () => {
  afterEach(() => {
    document.querySelectorAll('link[rel~="icon"]').forEach(link => link.remove());
    delete window.gianDesktop;
  });

  it('derives the same warm ember stops as the status gradient tokens', () => {
    expect(gianIconGradient('warm', 'ember')).toEqual([
      'oklch(0.64 0.18 -11)',
      'oklch(0.73 0.20 43)',
      'oklch(0.56 0.18 95)',
    ]);
  });

  it('builds the selected eye-free Dragon-G mark', () => {
    const svg = buildGianIconSvg('dark', 'plum');
    expect(svg).toContain('oklch(0.7 0.18 274)');
    expect(svg).toContain('oklch(0.8 0.20 328)');
    expect(svg).toContain('oklch(0.62 0.18 380)');
    expect(svg).toContain('<stop offset="100%" stop-color="oklch(0.62 0.18 380)"/>');
    expect(svg).not.toContain('offset="78%"');
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).not.toMatch(/eye|<ellipse|<circle/i);
    expect(svg).not.toContain('data-gian-dev-badge');
  });

  it('adds a DEV badge only when the development variant is requested', () => {
    const development = buildGianIconSvg('warm', 'ember', true);
    const production = buildGianIconSvg('warm', 'ember');
    expect(development).toContain('data-gian-dev-badge="true"');
    expect(development).toContain('>DEV</text>');
    expect(production).not.toContain('data-gian-dev-badge');
  });

  it('updates the browser favicon when appearance changes', () => {
    applyGianIconAppearance('light', 'azure');
    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    expect(link?.type).toBe('image/svg+xml');
    expect(link?.href).toContain('data:image/svg+xml');
    expect(decodeURIComponent(link?.href ?? '')).toContain('oklch(0.66 0.17 184)');
  });

  it('reads the development identity from the desktop bridge', () => {
    window.gianDesktop = { appVariant: 'development' };
    applyGianIconAppearance('warm', 'ember');
    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    expect(decodeURIComponent(link?.href ?? '')).toContain('data-gian-dev-badge="true"');
  });

  it('reserves the standard optical margin only for macOS icon canvases', () => {
    expect(GIAN_MACOS_ICON_SCALE).toBe(0.84);
  });
});
