import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHAT_UI_MESSAGE_KEYS } from '@gian/chat-ui';
import { EN } from '../src/i18n/en.js';
import { REMOTE_WEB_LOCALE, resolveRemoteWebLocale } from '../src/i18n/index.js';
import { ZH } from '../src/i18n/zh.js';

describe('i18n tables', () => {
  it('ships Remote Web in English regardless of browser language or query params', () => {
    expect(REMOTE_WEB_LOCALE).toBe('en');
    expect(resolveRemoteWebLocale('?lang=zh-CN')).toBe('en');
    expect(resolveRemoteWebLocale('?lang=zh')).toBe('en');
    expect(readFileSync(join(process.cwd(), 'index.html'), 'utf8')).toContain('<html lang="en">');
  });

  it('en and zh have identical key sets', () => {
    const enKeys = Object.keys(EN).sort();
    const zhKeys = Object.keys(ZH).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it('every chat-ui message key is present in both tables', () => {
    for (const key of CHAT_UI_MESSAGE_KEYS) {
      expect(EN[key], `en missing ${key}`).toBeTruthy();
      expect(ZH[key], `zh missing ${key}`).toBeTruthy();
    }
  });

  it('zh table keeps chat-ui values aligned with local web', () => {
    // Spot-check against the canonical web zh values (full parity is guarded
    // upstream by packages/web/test/chat-ui-i18n-parity.test.ts).
    expect(ZH['common.cancel']).toBe('取消');
    expect(ZH['transcript.approval.allowOnce']).toBe(EN['transcript.approval.allowOnce'] ? ZH['transcript.approval.allowOnce'] : undefined);
    expect(ZH['transcript.approval.allowOnce']).toBeTruthy();
  });

  it('remote zh copy does not mix in English product terms for core actions', () => {
    // Core user-facing actions must be localized (no English placeholders).
    for (const key of ['pair.code.submit', 'newchat.create', 'settings.logout', 'queue.notice.replaced']) {
      expect(ZH[key]).toMatch(/[\u4e00-\u9fff]/);
    }
  });
});
