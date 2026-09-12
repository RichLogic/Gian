import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Static guards for the Agents page stylesheet (WP4 + Issue #157): the
// letter-spacing rule stays explicit and primary navigation remains outside
// the page component at every responsive width.
describe('agents-page.css', () => {
  const css = readFileSync('src/styles/agents-page.css', 'utf8');

  it('uses letter-spacing: 0, never letter-spacing: normal', () => {
    expect(css).not.toContain('letter-spacing: normal');
    expect(css).toContain('letter-spacing: 0');
  });

  it('does not recreate or hide primary navigation inside AgentsView', () => {
    expect(css).not.toContain('agents-head-nav');
    expect(css).not.toContain('.agents-view > .sidebar');
  });

  it('uses one taller header geometry so both bodies start at the same height', () => {
    const head = css.match(/\.p2-head\s*\{([^}]*)\}/)?.[1] ?? '';
    const pageHead = css.match(/\.page-head\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(head).toMatch(/height:\s*var\(--agents-header-h\)/);
    expect(pageHead).toMatch(/height:\s*var\(--agents-header-h\)/);
    expect(head).toMatch(/padding:\s*0 14px/);
  });

  it('gives panel 2 the same vertical inset as the main card', () => {
    // `.main` carries `margin: var(--sp-2) 0` (gian-v2.css); a bare `.p2`
    // rendered a full-height card that stuck out above/below the main pane.
    const p2 = css.match(/\.p2\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(p2).toMatch(/margin:\s*var\(--sp-2\)\s*0/);
  });

  it('caps panel 1 at half and top-aligns field labels with their values', () => {
    expect(css).toMatch(/\.agents-view:has\(> \.p2\) > \.main-pane\s*\{\s*max-width:\s*50%/);
    expect(css).toMatch(/\.p2 \.kv-grid dt\s*\{[^}]*align-self:\s*start/s);
  });
});
