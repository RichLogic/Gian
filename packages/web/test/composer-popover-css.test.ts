import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Static guards for the composer popover frames (coding.css): the `+` add
// menu, the `@` file popover, the slash popover, and the session-reference
// picker are one visual family and must share the `.popover` base frame
// tokens — surface / r-3 / shadow-2. The picker originally overrode these
// with the tinted --surface-2 / --r-2 / hairline-shadow frame, which read as
// a lavender sheet next to the clean `+` menu.
describe('composer popover frames (coding.css)', () => {
  const css = readFileSync('src/styles/coding.css', 'utf8');
  const frame = (selector: string) =>
    css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

  for (const selector of ['\\.cmp-session-pop', '\\.cmp-file-pop', '\\.cmp-slash-pop']) {
    describe(selector, () => {
      it('uses the standard popover surface, radius, and shadow tokens', () => {
        const body = frame(selector);
        expect(body).toMatch(/background:\s*var\(--surface\)/);
        expect(body).toMatch(/border-radius:\s*var\(--r-3\)/);
        expect(body).toMatch(/box-shadow:\s*var\(--shadow-2\)/);
        expect(body).not.toContain('var(--surface-2)');
        expect(body).not.toContain('var(--r-2)');
      });
    });
  }

  it('fixed-positions the session picker like the other portaled popovers', () => {
    const body = frame('\\.cmp-session-pop');
    expect(body).toMatch(/position:\s*fixed/);
    expect(body).toMatch(/z-index:\s*100/);
  });
});
