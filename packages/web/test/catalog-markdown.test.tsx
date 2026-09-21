import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CatalogMarkdown } from '../src/agents/CatalogMarkdown.js';

// WP4 (issue #146): restricted Catalog Markdown. Raw HTML never renders,
// only https: links survive, images degrade to alt text.

describe('CatalogMarkdown', () => {
  it('renders ordinary markdown (headings, lists, tables, code)', () => {
    render(<CatalogMarkdown source={'# Title\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n`code`'} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Title');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByText('code').tagName).toBe('CODE');
  });

  it('never injects raw HTML or scripts', () => {
    const { container } = render(
      <CatalogMarkdown source={'<script>alert(1)</script>\n\n<div onclick="x()">hi</div>'} />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('div[onclick]')).toBeNull();
    // The raw source shows up as inert text, not markup.
    expect(container.textContent).toContain('alert(1)');
  });

  it('keeps only https: links as links', () => {
    const { container } = render(
      <CatalogMarkdown source={[
        '[safe](https://example.com/docs)',
        '[http](http://example.com)',
        '[js](javascript:alert(1))',
        '[data](data:text/html,<script>alert(1)</script>)',
        '[relative](./local.md)',
      ].join('\n\n')} />,
    );
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('https://example.com/docs');
    expect(links[0].getAttribute('rel')).toContain('noopener');
    // No in-app browser behavior is mounted here → status-quo _blank.
    expect(links[0].getAttribute('target')).toBe('_blank');
    // Unsafe/degraded links render as plain text instead — never anchors,
    // never inert spans.
    expect(container.querySelector('.link-inert')).toBeNull();
    expect(screen.getByText('http').tagName).not.toBe('A');
    expect(container.textContent).toContain('js');
    expect(container.textContent).toContain('data');
    expect(container.textContent).toContain('relative');
  });

  it('renders images as alt text, never as img elements', () => {
    const { container } = render(
      <CatalogMarkdown source={'![logo](https://example.com/logo.png)'} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('logo');
  });
});
