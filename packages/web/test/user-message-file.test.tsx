import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LocaleProvider } from '../src/i18n/index.js';
import { UserMessage } from '../src/transcript/items.js';

it('renders a generic user attachment as a download chip rather than an image', () => {
  render(
    <LocaleProvider locale="en">
      <UserMessage item={{
        kind: 'user',
        id: 'message-1',
        text: '',
        exec: 'claude',
        ts: 0,
        turn: 1,
        attachments: [{
          name: 'notes.txt',
          mime: 'text/plain',
          size: 1536,
          url: '/api/sessions/s1/attachments/uuid.txt',
        }],
      }} />
    </LocaleProvider>,
  );

  const link = screen.getByRole('link', { name: /notes\.txt/i });
  expect(link).toHaveAttribute('download', 'notes.txt');
  expect(link).toHaveAttribute('href', '/api/sessions/s1/attachments/uuid.txt');
  expect(screen.getByText('1.5 KB')).toBeInTheDocument();
  expect(link.querySelector('img')).toBeNull();
});

it('renders unsupported image formats as download chips', () => {
  render(
    <LocaleProvider locale="en">
      <UserMessage item={{
        kind: 'user',
        id: 'message-svg',
        text: '',
        exec: 'claude',
        ts: 0,
        turn: 1,
        attachments: [{
          name: 'diagram.svg',
          mime: 'image/svg+xml',
          size: 128,
          url: '/api/sessions/s1/attachments/uuid.svg',
        }],
      }} />
    </LocaleProvider>,
  );

  const link = screen.getByRole('link', { name: /diagram\.svg/i });
  expect(link).toHaveAttribute('download', 'diagram.svg');
  expect(link.querySelector('img')).toBeNull();
});

it('renders user message text through the shared markdown pipeline', () => {
  render(
    <LocaleProvider locale="en">
      <UserMessage item={{
        kind: 'user',
        id: 'message-md',
        text: 'ship **it** now',
        exec: 'claude',
        ts: 0,
        turn: 1,
      }} />
    </LocaleProvider>,
  );

  const text = document.querySelector('.user-text')!;
  expect(text.classList.contains('user-md')).toBe(true);
  expect(text.querySelector('strong')).toHaveTextContent('it');
});

it('renders structured references inline at their original message positions', async () => {
  render(
    <LocaleProvider locale="en">
      <UserMessage item={{
        kind: 'user',
        id: 'message-inline',
        text: 'Before  after',
        exec: 'claude',
        ts: 0,
        turn: 1,
        composerDocument: {
          version: 1,
          segments: [
            { type: 'text', text: 'Before ' },
            { type: 'reference', id: 'file-1', referenceType: 'attachment', label: 'notes.txt' },
            { type: 'text', text: ' after' },
          ],
        },
        attachments: [{
          name: 'notes.txt',
          mime: 'text/plain',
          url: '/api/sessions/s1/attachments/uuid.txt',
        }],
      }} />
    </LocaleProvider>,
  );

  const text = document.querySelector('.user-text');
  expect(text).toHaveTextContent('Before notes.txt after');
  const reference = text?.querySelector('[data-reference-id="file-1"]')!;
  // The chip previews on hover (a plain click is a no-op, 2026-09-10 owner
  // call); the download href lives in the popover body.
  expect(reference.tagName).toBe('BUTTON');
  const user = userEvent.setup();
  await user.click(reference);
  expect(screen.queryByRole('link', { name: 'Download' })).toBeNull();
  await user.hover(reference);
  const link = await screen.findByRole('link', { name: 'Download' });
  expect(link).toHaveAttribute('href', '/api/sessions/s1/attachments/uuid.txt');
  expect(document.querySelector('.msg-attachments')).toBeNull();
});
