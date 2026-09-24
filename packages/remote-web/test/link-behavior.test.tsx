// Remote file links resolve against the execution worktree, not the browser.

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
  it('keeps local browser/editor integration unavailable but supports remote relative files', () => {
    const behavior = createRemoteLinkBehavior({ openFile: vi.fn() });
    expect(behavior.openWebUrl).toBeNull();
    expect(behavior.openRelative).toBeTypeOf('function');
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

  it('resolves relative links through the remote transport, including missing-file errors', () => {
    const openFile = renderWithRemoteBehavior(<LinkAnchor href="./missing.md">missing</LinkAnchor>);
    fireEvent.click(screen.getByText('missing'));
    expect(openFile).toHaveBeenCalledWith('./missing.md');
  });

  it('keeps web links as plain _blank anchors (Remote Web runs in a real browser tab)', () => {
    renderWithRemoteBehavior(<LinkAnchor href="https://example.com">site</LinkAnchor>);
    const link = screen.getByRole('link');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });
});
