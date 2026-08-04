import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

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
