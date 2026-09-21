// Remote Web link behavior: the degradation contract. Remote has no in-app
// browser, no relative-link file index and no editor-scheme href factory —
// those behaviors stay null and the shared LinkAnchor must degrade VISIBLY
// (inert span + tooltip), never a dead <a> and never a swallowed click.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LinkAnchor, LinkBehaviorContext } from '@gian/chat-ui';
import { createRemoteLinkBehavior } from '../src/links/link-behavior.js';

function renderWithRemoteBehavior(ui: React.ReactElement, openFile = vi.fn()) {
  const behavior = createRemoteLinkBehavior({ openFile });
  const r = render(<LinkBehaviorContext.Provider value={behavior}>{ui}</LinkBehaviorContext.Provider>);
  return Object.assign(openFile, { container: r.container });
}

describe('createRemoteLinkBehavior', () => {
  it('declares web/relative/file-href as unavailable', () => {
    const behavior = createRemoteLinkBehavior({ openFile: vi.fn() });
    expect(behavior.openWebUrl).toBeNull();
    expect(behavior.openRelative).toBeNull();
    expect(behavior.fileHref).toBeNull();
  });

  it('routes file links through the remote file transport', () => {
    const openFile = renderWithRemoteBehavior(
      <LinkAnchor node={{ properties: { dataFileAbs: '/repo/a.ts' } }} href="./a.ts">a.ts</LinkAnchor>,
    );
    // No editor-scheme href in remote (fileHref: null) — the anchor is
    // click-only, so it has no accessible link role; query the element.
    const link = openFile.container.querySelector('a')!;
    expect(link.getAttribute('href')).toBeNull();
    fireEvent.click(link);
    expect(openFile).toHaveBeenCalledWith('/repo/a.ts', undefined);
  });

  it('renders relative links as inert spans with an explanatory tooltip (not a swallowed click)', () => {
    renderWithRemoteBehavior(<LinkAnchor href="./missing.md">missing</LinkAnchor>);
    expect(screen.queryByRole('link')).toBeNull();
    const span = screen.getByText('missing');
    expect(span.tagName).toBe('SPAN');
    expect(span.className).toContain('link-inert');
    expect(span.getAttribute('title')).toContain('./missing.md');
    expect(span.getAttribute('title')).toContain('not available');
  });

  it('keeps web links as plain _blank anchors (Remote Web runs in a real browser tab)', () => {
    renderWithRemoteBehavior(<LinkAnchor href="https://example.com">site</LinkAnchor>);
    const link = screen.getByRole('link');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });
});
