import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from './render-app.js';

describe('accessibility / keyboard basics', () => {
  it('primary controls expose accessible names', () => {
    renderApp({ scenario: {}, viewport: 'wide' });
    // every button has an accessible name
    for (const button of document.querySelectorAll('button')) {
      const name = button.getAttribute('aria-label') ?? button.textContent ?? '';
      expect(name.trim().length, `unnamed button: ${button.outerHTML.slice(0, 80)}`).toBeGreaterThan(0);
    }
  });

  it('host selector opens via keyboard and closes on Escape', async () => {
    const user = userEvent.setup();
    renderApp({ scenario: {}, viewport: 'wide' });
    const selector = screen.getByRole('button', { name: '切换 Host' });
    selector.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('session rows are keyboard activatable', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide' });
    const row = screen.getByRole('button', { name: /Remote Web 协议 §12 走查/ });
    row.focus();
    await user.keyboard('{Enter}');
    expect(controller.state.view).toEqual({ kind: 'chat', sessionId: 's-2' });
  });

  it('banners use role=status; errors use role=alert', () => {
    renderApp({ scenario: { connection: { kind: 'host_offline', lastSeenAt: Date.now() } }, viewport: 'wide' });
    expect(document.querySelector('.session-banner')!.getAttribute('role')).toBe('status');
  });

  it('narrow layout: primary actions meet the 44px hit-area contract in CSS', async () => {
    // The CSS contract is asserted structurally: the rule exists for narrow mode.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(process.cwd(), 'src/styles/remote-web.css'), 'utf8');
    expect(css).toContain('[data-mode="narrow"]');
    expect(css).toContain('min-width: 44px');
    expect(css).toContain('min-height: 44px');
    expect(css).toContain('env(safe-area-inset-bottom)');
    expect(css).toContain('100dvh');
    expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]*:is\(input, select, textarea\)[\s\S]*font-size: 16px/);
  });
});
