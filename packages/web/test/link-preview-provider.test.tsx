// links/LinkBehaviorProvider.tsx — wiring: the provider mounts both the
// LinkBehavior and the LinkPreviewContext above the transcript subtree, so
// web links can unfurl on hover. (Remote Web mounts neither — its plain
// anchors are the degradation contract.)

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LinkBehaviorContext, LinkPreviewContext } from '@gian/chat-ui';
import { useContext } from 'react';
import { LinkBehaviorProvider } from '../src/links/LinkBehaviorProvider.js';

function ContextProbe() {
  const behavior = useContext(LinkBehaviorContext);
  const preview = useContext(LinkPreviewContext);
  return (
    <div>
      <span data-testid="behavior">{behavior ? 'behavior' : 'none'}</span>
      <span data-testid="preview">{preview ? 'preview' : 'none'}</span>
    </div>
  );
}

describe('LinkBehaviorProvider', () => {
  it('mounts the link behavior and the preview context together', () => {
    render(
      <LinkBehaviorProvider
        openFileInSheet={vi.fn()}
        openRelativeFileHref={vi.fn()}
        openUrlInBrowser={vi.fn().mockReturnValue(false)}
      >
        <ContextProbe />
      </LinkBehaviorProvider>,
    );
    expect(screen.getByTestId('behavior').textContent).toBe('behavior');
    expect(screen.getByTestId('preview').textContent).toBe('preview');
  });

  it('keeps the preview client stable across re-renders (session cache)', () => {
    const clients = new Set<unknown>();
    function Capture() {
      clients.add(useContext(LinkPreviewContext));
      return null;
    }
    const props = {
      openFileInSheet: vi.fn(),
      openRelativeFileHref: vi.fn(),
      openUrlInBrowser: vi.fn().mockReturnValue(false),
    };
    const { rerender } = render(
      <LinkBehaviorProvider {...props}><Capture /></LinkBehaviorProvider>,
    );
    rerender(<LinkBehaviorProvider {...props}><Capture /></LinkBehaviorProvider>);
    expect(clients.size).toBe(1);
  });
});
