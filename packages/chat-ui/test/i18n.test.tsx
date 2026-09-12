// chat-ui i18n: the key set is closed and every key has an English fallback;
// a host-supplied translator overrides the fallback through the provider.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  CHAT_UI_DEFAULT_EN,
  CHAT_UI_MESSAGE_KEYS,
  ChatUiI18nProvider,
  useChatUiT,
} from '../src/i18n.js';

function KeyText({ k }: { k: (typeof CHAT_UI_MESSAGE_KEYS)[number] }) {
  const t = useChatUiT();
  return <span>{t(k)}</span>;
}

describe('chat-ui i18n', () => {
  it('every declared key has an English fallback', () => {
    expect(CHAT_UI_MESSAGE_KEYS.length).toBe(new Set(CHAT_UI_MESSAGE_KEYS).size);
    for (const key of CHAT_UI_MESSAGE_KEYS) {
      const value = CHAT_UI_DEFAULT_EN[key];
      expect(typeof value, key).toBe('string');
      expect(value.length, key).toBeGreaterThan(0);
    }
  });

  it('renders the English fallback without a provider', () => {
    render(<KeyText k="transcript.turnsum.working" />);
    expect(screen.getByText('Working')).toBeInTheDocument();
  });

  it('a host translator overrides the fallback', () => {
    render(
      <ChatUiI18nProvider t={key => (key === 'transcript.turnsum.working' ? '进行中' : key)}>
        <KeyText k="transcript.turnsum.working" />
      </ChatUiI18nProvider>,
    );
    expect(screen.getByText('进行中')).toBeInTheDocument();
  });
});
