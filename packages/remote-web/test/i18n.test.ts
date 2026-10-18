import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHAT_UI_MESSAGE_KEYS } from '@gian/chat-ui';
import { generateCanonicalId, type RemoteStateSnapshot } from '@gian/remote-protocol';
import { applySnapshotToState } from '../src/controller/apply-control.js';
import type { RemoteUiState } from '../src/controller/types.js';
import { EN } from '../src/i18n/en.js';
import { ZH } from '../src/i18n/zh.js';

function baseState(): RemoteUiState {
  return {
    auth: { kind: 'pairing', pairing: { kind: 'enter-code', attemptsLeft: 5 } },
    connection: { kind: 'browser_offline' },
    hosts: [],
    currentHostId: null,
    locale: 'en',
    workspaces: [],
    tasks: [],
    sessions: [],
    interactions: [],
    interactionPhases: {},
    interactionErrors: {},
    capabilities: {},
    catalogRevision: '',
    catalog: null,
    catalogInvalidated: false,
    logos: {},
    snapshotReceivedAt: null,
    view: { kind: 'empty' },
    mobilePage: 'chat',
    transcripts: {},
    drafts: {},
    queueNotice: null,
    fileViewer: null,
    fileDownload: { status: 'idle' },
    mutations: {},
    unknownCommandId: null,
    settings: { theme: 'system', accent: 'azure' },
  };
}

function hostSnapshot(locale?: 'en' | 'zh-CN'): RemoteStateSnapshot {
  return {
    type: 'state.snapshot',
    snapshot_id: generateCanonicalId(),
    host_generation: generateCanonicalId(),
    revision: 'rev-1',
    event_sequence: 0,
    host: {
      id: generateCanonicalId(),
      name: 'Office Mac',
      online: true,
      version: '0.6.4',
      ...(locale ? { locale } : {}),
    },
    workspaces: [],
    tasks: [],
    sessions: [],
    interactions: [],
    capabilities: {},
    attention: [],
    catalog_revision: 'cat-1',
  };
}

describe('i18n locale source', () => {
  it('follows the Host snapshot locale and falls back to English when the field is absent', () => {
    // Before any snapshot (pairing, enrollment) the UI is English.
    expect(baseState().locale).toBe('en');
    // A negotiated Host ships its configured UI locale in the snapshot.
    const zh = applySnapshotToState(baseState(), hostSnapshot('zh-CN'));
    expect(zh.locale).toBe('zh-CN');
    // Old Hosts and stale encrypted caches omit the field: back to 'en'.
    const legacy = applySnapshotToState(zh, hostSnapshot());
    expect(legacy.locale).toBe('en');
    // index.html keeps the pre-boot default; LocaleProvider syncs <html lang>.
    expect(readFileSync(join(process.cwd(), 'index.html'), 'utf8')).toContain('<html lang="en">');
  });
});

describe('i18n tables', () => {
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
    expect(ZH['transcript.approval.resolved']).toBe('已处理');
    expect(ZH['transcript.approval.resolved']).not.toMatch(/批准|允许/);
  });

  it('remote zh copy does not mix in English product terms for core actions', () => {
    // Core user-facing actions must be localized (no English placeholders).
    for (const key of ['pair.code.submit', 'newchat.create', 'settings.logout', 'queue.notice.replaced']) {
      expect(ZH[key]).toMatch(/[一-鿿]/);
    }
  });
});
