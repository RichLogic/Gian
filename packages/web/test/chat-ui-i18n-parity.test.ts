// Guards the chat-ui English fallback table against drift: the shared package
// renders these strings when no host translator is mounted (standalone tests,
// fixtures), so they must match the product's English copy exactly. Locale
// wiring itself (zh/en through LocaleProvider → ChatUiI18nContext) is covered
// by the transcript component tests.

import { describe, expect, it } from 'vitest';
import { CHAT_UI_DEFAULT_EN, CHAT_UI_MESSAGE_KEYS } from '@gian/chat-ui';
import { EN } from '../src/i18n/en.js';
import { ZH } from '../src/i18n/zh.js';

describe('chat-ui i18n parity', () => {
  it('every chat-ui key exists in both web locale tables', () => {
    for (const key of CHAT_UI_MESSAGE_KEYS) {
      expect(EN, key).toHaveProperty(key);
      expect(ZH, key).toHaveProperty(key);
    }
  });

  it('chat-ui English fallbacks match web English copy', () => {
    for (const key of CHAT_UI_MESSAGE_KEYS) {
      expect(CHAT_UI_DEFAULT_EN[key], key).toBe(EN[key as keyof typeof EN]);
    }
  });
});
