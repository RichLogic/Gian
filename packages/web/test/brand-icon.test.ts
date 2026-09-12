import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyGianIconAppearance,
  buildGianIconSvg,
  GIAN_MACOS_ICON_SCALE,
  gianIconGradient,
} from '../src/brand-icon.js';

// 2026-09-08 owner call: the brand gradient is FIXED to the former Plum
// accent's hues; the logo no longer follows the accent setting.
describe('Plum-fixed Gian icon', () => {
  afterEach(() => {
    document.querySelectorAll('link[rel~="icon"]').forEach(link => link.remove());
    delete window.gianDesktop;
  });

  it('derives the Plum stops per theme (hue 320, chroma 0.14)', () => {
    expect(gianIconGradient('warm')).toEqual([
      'oklch(0.64 0.18 274)',
      'oklch(0.73 0.20 328)',
      'oklch(0.56 0.18 380)',
    ]);
    expect(gianIconGradient('light')).toEqual([
      'oklch(0.66 0.18 274)',
      'oklch(0.74 0.20 328)',
      'oklch(0.58 0.18 380)',
    ]);
    expect(gianIconGradient('dark')).toEqual([
      'oklch(0.7 0.18 274)',
      'oklch(0.8 0.20 328)',
      'oklch(0.62 0.18 380)',
    ]);
  });

  it('builds the selected eye-free Dragon-G mark', () => {
    const svg = buildGianIconSvg('dark');
    expect(svg).toContain('oklch(0.7 0.18 274)');
    expect(svg).toContain('oklch(0.8 0.20 328)');
    expect(svg).toContain('oklch(0.62 0.18 380)');
    expect(svg).toContain('<stop offset="100%" stop-color="oklch(0.62 0.18 380)"/>');
    expect(svg).not.toContain('offset="78%"');
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).not.toMatch(/eye|<ellipse|<circle/i);
    expect(svg).not.toContain('data-gian-dev-badge');
  });

  it('keeps every static default icon on the warm Plum gradient', () => {
    const expectedStops = gianIconGradient('warm');
    const iconPaths = [
      resolve(process.cwd(), 'public/gian-icon.svg'),
      resolve(process.cwd(), '../desktop/renderer/gian-icon.svg'),
      resolve(process.cwd(), '../../.github/assets/readme/gian-icon.svg'),
    ];
    const icons = iconPaths.map(path => readFileSync(path, 'utf8'));

    expect(new Set(icons).size).toBe(1);
    for (const icon of icons) {
      for (const stop of expectedStops) expect(icon).toContain(`stop-color="${stop}"`);
      expect(icon).not.toContain('oklch(0.64 0.18 -11)');
      expect(icon).not.toContain('data-gian-dev-badge');
    }
  });

  it('adds a DEV badge only when the development variant is requested', () => {
    const development = buildGianIconSvg('warm', true);
    const production = buildGianIconSvg('warm');
    expect(development).toContain('data-gian-dev-badge="true"');
    expect(development).toContain('>DEV</text>');
    expect(production).not.toContain('data-gian-dev-badge');
  });

  it('updates the browser favicon when appearance changes', () => {
    applyGianIconAppearance('light');
    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    expect(link?.type).toBe('image/svg+xml');
    expect(link?.href).toContain('data:image/svg+xml');
    expect(decodeURIComponent(link?.href ?? '')).toContain('oklch(0.66 0.18 274)');
  });

  it('reads the development identity from the desktop bridge', () => {
    window.gianDesktop = { appVariant: 'development' };
    applyGianIconAppearance('warm');
    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    expect(decodeURIComponent(link?.href ?? '')).toContain('data-gian-dev-badge="true"');
  });

  it('reserves the standard optical margin only for macOS icon canvases', () => {
    expect(GIAN_MACOS_ICON_SCALE).toBe(0.84);
  });
});
