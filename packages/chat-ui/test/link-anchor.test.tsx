// links/LinkAnchor.tsx — the single anchor component: classify → policy →
// behavior. Covers per-kind routing, the inert fallback (never a dead <a>,
// never a swallowed click), unsafe → plain text, policy overrides, and the
// per-kind icons.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { LinkAnchor } from '../src/links/LinkAnchor.js';
import {
  LinkBehaviorContext,
  LinkPolicyContext,
} from '../src/links/LinkBehaviorContext.js';
import { plainTextPolicy, strictHttpsPolicy } from '../src/links/policy.js';
import type { LinkBehavior } from '../src/links/LinkBehaviorContext.js';

function withBehavior(behavior: LinkBehavior | null, ui: React.ReactElement) {
  return <LinkBehaviorContext.Provider value={behavior}>{ui}</LinkBehaviorContext.Provider>;
}

describe('LinkAnchor web links', () => {
  it('falls back to a _blank anchor (with noreferrer noopener) when no openWebUrl behavior exists', () => {
    const { container } = render(<LinkAnchor href="https://example.com">site</LinkAnchor>);
    const link = container.querySelector('a')!;
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
    expect(link.getAttribute('data-link-kind')).toBe('web');
  });

  it('routes through openWebUrl (no _blank) when the behavior is mounted', () => {
    const openWebUrl = vi.fn();
    const { container } = render(
      withBehavior({ openWebUrl }, <LinkAnchor href="https://example.com">site</LinkAnchor>),
    );
    const link = container.querySelector('a')!;
    expect(link.getAttribute('target')).toBeNull();
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(fireEvent.click(link)).toBe(false);
    expect(openWebUrl).toHaveBeenCalledWith('https://example.com');
  });

  it('shows a globe icon', () => {
    const { container } = render(<LinkAnchor href="https://example.com">site</LinkAnchor>);
    expect(container.querySelector('svg[data-link-icon="web"]')).not.toBeNull();
  });
});

describe('LinkAnchor file links', () => {
  const node = { properties: { dataFileAbs: '/repo/src/a.ts', dataFileLine: '12' } };

  it('routes clicks through openFile with the resolved path and line', () => {
    const openFile = vi.fn();
    const { container } = render(
      withBehavior({ openFile }, <LinkAnchor node={node} href="./a.ts">a.ts</LinkAnchor>),
    );
    const link = container.querySelector('a.file-link')!;
    expect(link.className).toContain('file-link-auto');
    expect(fireEvent.click(link)).toBe(false);
    expect(openFile).toHaveBeenCalledWith('/repo/src/a.ts', 12);
  });

  it('uses the host fileHref factory for the anchor href', () => {
    const { container } = render(
      withBehavior(
        { openFile: vi.fn(), fileHref: (p, line) => `app://open${p}${line ? `:${line}` : ''}` },
        <LinkAnchor node={node} href="./a.ts">a.ts</LinkAnchor>,
      ),
    );
    expect(container.querySelector('a')!.getAttribute('href')).toBe('app://open/repo/src/a.ts:12');
  });

  it('renders an inert span (never a dead <a>) when no openFile behavior exists', () => {
    const { container } = render(<LinkAnchor node={node} href="./a.ts">a.ts</LinkAnchor>);
    expect(container.querySelector('a')).toBeNull();
    const span = container.querySelector('span.link-inert')!;
    expect(span.getAttribute('title')).toContain('Opening this link is not available here');
    expect(span.querySelector('svg[data-link-icon="file-ts"]')).not.toBeNull();
  });
});

describe('LinkAnchor relative links', () => {
  it('routes through openRelative when mounted (SPA never navigates)', () => {
    const openRelative = vi.fn();
    const { container } = render(
      withBehavior({ openRelative }, <LinkAnchor href="./missing.md">missing</LinkAnchor>),
    );
    expect(fireEvent.click(container.querySelector('a')!)).toBe(false);
    expect(openRelative).toHaveBeenCalledWith('./missing.md');
  });

  it('renders an inert span with a tooltip instead of swallowing the click when no behavior exists', () => {
    const { container } = render(<LinkAnchor href="./missing.md">missing</LinkAnchor>);
    expect(container.querySelector('a')).toBeNull();
    const span = container.querySelector('span.link-inert')!;
    expect(span.getAttribute('title')).toContain('./missing.md');
    expect(span.getAttribute('title')).toContain('not available');
  });
});

describe('LinkAnchor editor / external-scheme / fragment links', () => {
  it('lets editor schemes navigate through the platform default', () => {
    const { container } = render(<LinkAnchor href="vscode://file/repo/a.ts:3">open</LinkAnchor>);
    const link = container.querySelector('a')!;
    expect(link.getAttribute('data-link-kind')).toBe('editor');
    expect(link.getAttribute('target')).toBeNull();
    expect(link.querySelector('svg[data-link-icon="editor"]')).not.toBeNull();
  });

  it('lets external schemes (mailto:) navigate through the platform default', () => {
    const { container } = render(<LinkAnchor href="mailto:dev@example.com">mail</LinkAnchor>);
    const link = container.querySelector('a')!;
    expect(link.getAttribute('data-link-kind')).toBe('external-scheme');
    expect(link.querySelector('svg[data-link-icon="external-scheme"]')).not.toBeNull();
  });

  it('renders fragments without an icon', () => {
    const { container } = render(<LinkAnchor href="#details">jump</LinkAnchor>);
    const link = container.querySelector('a')!;
    expect(link.getAttribute('data-link-kind')).toBe('fragment');
    expect(link.querySelector('svg')).toBeNull();
  });
});

describe('LinkAnchor unsafe targets', () => {
  it('never renders javascript: as an anchor — plain text only', () => {
    const { container } = render(
      <LinkAnchor href="javascript:alert(1)">click me</LinkAnchor>,
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('span.link-inert')).toBeNull();
    expect(container.textContent).toBe('click me');
  });

  it('never renders data: as an anchor', () => {
    const { container } = render(
      <LinkAnchor href="data:text/html,<b>x</b>">x</LinkAnchor>,
    );
    expect(container.querySelector('a')).toBeNull();
  });
});

describe('LinkAnchor policies', () => {
  it('strictHttpsPolicy renders https as a link but http as plain text', () => {
    const { container } = render(
      <LinkPolicyContext.Provider value={strictHttpsPolicy}>
        <LinkAnchor href="https://example.com">safe</LinkAnchor>
        <LinkAnchor href="http://example.com">unsafe-http</LinkAnchor>
        <LinkAnchor href="./rel.md">relative</LinkAnchor>
      </LinkPolicyContext.Provider>,
    );
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('https://example.com');
    expect(container.textContent).toContain('unsafe-http');
    expect(container.textContent).toContain('relative');
  });

  it('plainTextPolicy renders every link as plain text', () => {
    const { container } = render(
      <LinkPolicyContext.Provider value={plainTextPolicy}>
        <LinkAnchor href="https://example.com">site</LinkAnchor>
      </LinkPolicyContext.Provider>,
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('site');
  });
});
