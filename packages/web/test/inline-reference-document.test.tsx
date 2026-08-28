import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ComposerDocument, MessageContextItem } from '@gian/shared';
import { InlineReferenceDocument } from '../src/components/composer/InlineReferenceDocument.js';

const BROWSER_ELEMENT: MessageContextItem = {
  type: 'browserElement',
  id: 'ctx-1',
  pageUrl: 'http://127.0.0.1:5191/',
  pageTitle: 'Gian',
  tagName: 'span',
  selector: 'span.ri-title',
  attributes: {},
  contentOmitted: false,
  snippet: '<span class="ri-title"></span>',
};

function documentWithReference(): ComposerDocument {
  return {
    version: 1,
    segments: [
      { type: 'reference', id: 'ctx-1', referenceType: 'context', label: 'span.ri-title' },
      { type: 'text', text: ' look at this' },
    ],
  };
}

describe('InlineReferenceDocument', () => {
  it('opens a floating detail card when a context chip is clicked', async () => {
    const user = userEvent.setup();
    render(
      <InlineReferenceDocument
        document={documentWithReference()}
        contextItems={[BROWSER_ELEMENT]}
      />,
    );

    const chip = screen.getByRole('button', { name: /span\.ri-title/ });
    expect(document.querySelector('.ref-pop')).toBeNull();

    await user.click(chip);
    expect(document.querySelector('.ref-pop')).not.toBeNull();
    expect(screen.getByText('Browser element')).toBeInTheDocument();
    expect(screen.getByText('Gian')).toBeInTheDocument();
    expect(screen.getByText('http://127.0.0.1:5191/')).toBeInTheDocument();
    expect(screen.getByText('<span class="ri-title"></span>')).toBeInTheDocument();

    // Clicking the chip again toggles the card closed.
    await user.click(chip);
    expect(document.querySelector('.ref-pop')).toBeNull();
  });

  it('closes the card on outside pointer down', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <InlineReferenceDocument
          document={documentWithReference()}
          contextItems={[BROWSER_ELEMENT]}
        />
        <button type="button">elsewhere</button>
      </div>,
    );

    await user.click(screen.getByRole('button', { name: /span\.ri-title/ }));
    expect(document.querySelector('.ref-pop')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(document.querySelector('.ref-pop')).toBeNull();
  });

  it('renders pasted text as markdown inside a scrollable region that does not close on scroll', async () => {
    const user = userEvent.setup();
    const pasted: MessageContextItem = {
      type: 'pastedText',
      id: 'ctx-md',
      text: '实现要点：\n\n- **Claude 风格**：米色背景\n- `code` 行内代码',
      lineCount: 3,
      byteSize: 60,
    };
    render(
      <InlineReferenceDocument
        document={{
          version: 1,
          segments: [
            { type: 'reference', id: 'ctx-md', referenceType: 'context', label: '实现要点' },
          ],
        }}
        contextItems={[pasted]}
      />,
    );

    await user.click(screen.getByRole('button', { name: /实现要点/ }));
    const snippet = document.querySelector('.ref-pop-snippet.ref-pop-md');
    expect(snippet).not.toBeNull();
    // Markdown is parsed, not shown raw.
    expect(snippet!.querySelector('strong')).toHaveTextContent('Claude 风格');
    expect(snippet!.querySelector('code')).toHaveTextContent('code');
    expect(snippet!.textContent).not.toContain('**');

    // Scrolling inside the popover keeps it open; a page scroll closes it.
    act(() => { snippet!.dispatchEvent(new Event('scroll', { bubbles: false })); });
    expect(document.querySelector('.ref-pop')).not.toBeNull();
    act(() => { document.body.dispatchEvent(new Event('scroll', { bubbles: false })); });
    expect(document.querySelector('.ref-pop')).toBeNull();
  });

  it('labels transcript-selection text as Quote instead of Pasted text', async () => {
    const user = userEvent.setup();
    const quote: MessageContextItem = {
      type: 'pastedText',
      id: 'ctx-quote',
      text: 'quoted from the transcript',
      lineCount: 1,
      byteSize: 26,
      origin: 'selection',
    };
    render(
      <InlineReferenceDocument
        document={{
          version: 1,
          segments: [
            { type: 'reference', id: 'ctx-quote', referenceType: 'context', label: 'quoted from' },
          ],
        }}
        contextItems={[quote]}
      />,
    );

    await user.click(screen.getByRole('button', { name: /quoted from/ }));
    expect(screen.getByText('Quote')).toBeInTheDocument();
    expect(screen.queryByText('Pasted text')).toBeNull();
  });

  it('renders a plain chip when the referenced context item is missing', () => {
    render(
      <InlineReferenceDocument
        document={documentWithReference()}
        contextItems={[]}
      />,
    );
    expect(screen.queryByRole('button', { name: /span\.ri-title/ })).toBeNull();
    expect(screen.getByText('span.ri-title')).toBeInTheDocument();
  });

  it('keeps attachment chips as download links', () => {
    render(
      <InlineReferenceDocument
        document={{
          version: 1,
          segments: [
            { type: 'reference', id: 'att-1', referenceType: 'attachment', label: 'notes.txt' },
          ],
        }}
        attachments={[{ name: 'notes.txt', url: '/api/sessions/s/attachments/notes.txt' }]}
      />,
    );
    const link = screen.getByRole('link', { name: /notes\.txt/ });
    expect(link).toHaveAttribute('href', '/api/sessions/s/attachments/notes.txt');
  });
});
