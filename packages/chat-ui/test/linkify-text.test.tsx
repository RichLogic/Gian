// links/linkify-text.tsx — plain-text URL linkification for user messages:
// conservative https?:// tokenizer, trailing-punctuation trim, and policy
// gating. No markdown parsing, no file-path sniffing (phase 1).

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { LinkifiedText, splitLinkTokens } from '../src/links/linkify-text.js';
import { LinkPolicyContext } from '../src/links/LinkBehaviorContext.js';
import { plainTextPolicy } from '../src/links/policy.js';

describe('splitLinkTokens', () => {
  it('returns a single text token when there is no URL', () => {
    expect(splitLinkTokens('hello world')).toEqual([{ type: 'text', value: 'hello world' }]);
  });

  it('splits one URL out of surrounding prose', () => {
    expect(splitLinkTokens('see https://example.com/docs for details')).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'url', value: 'https://example.com/docs' },
      { type: 'text', value: ' for details' },
    ]);
  });

  it('splits multiple URLs', () => {
    const tokens = splitLinkTokens('a https://one.com b http://two.com c');
    expect(tokens.filter(t => t.type === 'url').map(t => t.value)).toEqual([
      'https://one.com',
      'http://two.com',
    ]);
  });

  it('trims trailing sentence punctuation from URLs', () => {
    expect(splitLinkTokens('go to https://example.com.')).toEqual([
      { type: 'text', value: 'go to ' },
      { type: 'url', value: 'https://example.com' },
      { type: 'text', value: '.' },
    ]);
    expect(splitLinkTokens('(see https://example.com/a,b)')).toEqual([
      { type: 'text', value: '(see ' },
      { type: 'url', value: 'https://example.com/a,b' },
      { type: 'text', value: ')' },
    ]);
  });

  it('keeps a closing paren that is balanced inside the URL', () => {
    const tokens = splitLinkTokens('wiki https://en.wikipedia.org/wiki/Foo_(bar) here');
    expect(tokens.find(t => t.type === 'url')?.value).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
  });

  it('does not linkify non-http schemes or bare domains', () => {
    expect(splitLinkTokens('ftp://x.com example.com mailto:a@b.c').every(t => t.type === 'text')).toBe(true);
  });
});

describe('LinkifiedText', () => {
  it('renders URLs as LinkAnchors and the rest as plain text', () => {
    const { container } = render(<LinkifiedText text="see https://example.com now" />);
    const link = container.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://example.com');
    expect(link.getAttribute('data-link-kind')).toBe('web');
    expect(link.textContent).toContain('https://example.com');
    expect(container.textContent).toBe('see https://example.com now');
  });

  it('renders plain text unchanged when there is no URL', () => {
    const { container } = render(<LinkifiedText text="no links here" />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('no links here');
  });

  it('renders nothing linkified under plainTextPolicy', () => {
    const { container } = render(
      <LinkPolicyContext.Provider value={plainTextPolicy}>
        <LinkifiedText text="see https://example.com now" />
      </LinkPolicyContext.Provider>,
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('see https://example.com now');
  });
});
