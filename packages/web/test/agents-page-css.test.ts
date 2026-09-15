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
    expect(head).toMatch(/height:\s*var\(--mgmt-header-h\)/);
    expect(pageHead).toMatch(/height:\s*var\(--mgmt-header-h\)/);
    expect(head).toMatch(/padding:\s*0 16px/);
  });

  it('constrains panel 1 to the chat-style centered 820px content column', () => {
    // Owner request (2026-09-15): Agents/Custom/Timer panel 1 must not
    // stretch across the main island — head row and body content share the
    // chat panel-1 column (max-width 820px, auto inline margins).
    const row = css.match(/\.page-head \.ph-row\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(row).toMatch(/max-width:\s*820px/);
    expect(row).toMatch(/margin:\s*0 auto/);
    const column = css.match(/\.agents-view \.page-body > \*\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(column).toMatch(/max-width:\s*820px/);
    expect(column).toMatch(/margin-inline:\s*auto/);
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

  it('lifts the 50% cap once the user drags the panel-2 seam', () => {
    // The inline dragged width must win over the 50/50 flex split — without
    // this override the seam dragged but nothing moved (2026-09-15 owner).
    expect(css).toMatch(/\.agents-view\.p2-sized > \.main-pane\s*\{\s*max-width:\s*none/);
  });

  it('gives the Integration installation TTY a bounded scrollable output area', () => {
    const output = css.match(/\.integration-terminal-output\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(output).toMatch(/height:\s*216px/);
    expect(output).toMatch(/overflow:\s*auto/);
    expect(output).toMatch(/font:\s*500 var\(--fz-12\).*var\(--font-mono\)/);
  });
});
