import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The chat 字号 setting drives --chat-zone-scale on <body>, which re-feeds
// the per-zone --fz-* tokens. The translation UI used to opt out of that
// system: `.translation-block` was `font-size: 0.9em` (em resolves against
// inherited computed size — body's fixed 14px, never the zone scale) and the
// surrounding chrome was hardcoded px, so the translation area ignored the
// setting entirely (2026-10-18 fix). These guards pin the scale-aware rules.
describe('translation font scale (translation.css + tokens.css)', () => {
  const translation = readFileSync('src/translation/translation.css', 'utf8');
  const tokens = readFileSync('src/styles/tokens.css', 'utf8');
  const rule = (css: string, selector: string) =>
    css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

  it('sizes the translation text off the --fz-* tokens, not bare em/px', () => {
    const block = rule(translation, '\\.translation-block');
    expect(block).toMatch(/font-size:\s*calc\(var\(--fz-13\)\s*\*\s*0\.9\)/);
    expect(block).not.toMatch(/font-size:\s*[\d.]+(px|em)\b/);
  });

  it('sizes the translation chrome with --fz-* tokens too', () => {
    for (const selector of [
      '\\.translation-label',
      '\\.translation-action > span',
      '\\.translation-send-row',
      '\\.translation-error',
    ]) {
      expect(rule(translation, selector)).toMatch(/font-size:\s*var\(--fz-/);
    }
  });

  it('re-declares the chat-zone scale on the body-portaled translation popover', () => {
    // The selection-translate popover is portaled to <body>, outside
    // .transcript — without these it inherits body's fixed scale.
    const zoneRule = tokens.match(
      /\.transcript, \.composer, \.composer-wrap, \.approval,?\s*\n?\.translation-popover\s*\{([^}]*)\}/,
    )?.[1] ?? '';
    expect(zoneRule).toContain('--zone-scale: var(--chat-zone-scale, 1)');
    // And it must sit in the shared --fz-* re-declaration block so the tokens
    // re-evaluate with its own --zone-scale.
    const fzBlock = tokens.match(/--fz-10:\s*calc/)?.input ?? '';
    expect(fzBlock).toMatch(/\.translation-popover,?\s*\n\.sheet/);
  });
});
