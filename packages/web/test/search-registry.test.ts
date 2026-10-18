/**
 * Static search registry (Issue #168 / 0.6.7): settings keyed by real
 * section anchors, commands by real keymap command ids; locale titles plus
 * bilingual aliases; availability predicates; deterministic ranking.
 */
import { describe, expect, it } from 'vitest';
import { KEYMAP_COMMANDS } from '@gian/shared';
import { EN } from '../src/i18n/en.js';
import { ZH } from '../src/i18n/zh.js';
import {
  COMMANDS_SEARCH_REGISTRY,
  SETTINGS_SEARCH_REGISTRY,
  matchRegistryEntries,
  settingAnchorId,
  type SearchPaletteContext,
} from '../src/search/registry.js';

const FULL_CONTEXT: SearchPaletteContext = {
  hasActiveSession: true,
  workbenchActive: true,
  canGoBack: true,
  canGoForward: true,
  inspectorAvailable: true,
  browserAvailable: true,
};

const bothTitles = (entry: { titleKey: string }) => {
  const en = EN[entry.titleKey] ?? entry.titleKey;
  const zh = ZH[entry.titleKey] ?? entry.titleKey;
  return en === zh ? [en] : [en, zh];
};

describe('search registry', () => {
  it('every registry command is a real keymap command with a real label', () => {
    const known = new Set<string>(KEYMAP_COMMANDS);
    for (const entry of COMMANDS_SEARCH_REGISTRY) {
      expect(known.has(entry.command)).toBe(true);
      expect(typeof EN[entry.titleKey]).toBe('string');
    }
  });

  it('every settings entry resolves to a real section label', () => {
    for (const entry of SETTINGS_SEARCH_REGISTRY) {
      expect(typeof EN[entry.titleKey]).toBe('string');
    }
  });

  it('matches titles case-insensitively and ranks exact > prefix > substring > alias', () => {
    const matches = matchRegistryEntries(SETTINGS_SEARCH_REGISTRY, 'notifications', bothTitles);
    expect(matches[0]?.entry.navKey).toBe('notifications');
    expect(matches[0]?.rank).toBe(0);

    const alias = matchRegistryEntries(SETTINGS_SEARCH_REGISTRY, 'alerts', bothTitles);
    expect(alias.map(match => match.entry.navKey)).toContain('notifications');
    expect(alias[0]?.rank).toBe(3);
  });

  it('matches Chinese short aliases by plain substring', () => {
    const matches = matchRegistryEntries(SETTINGS_SEARCH_REGISTRY, '通知', bothTitles);
    expect(matches.map(match => match.entry.navKey)).toContain('notifications');
  });

  it('unavailable commands are excluded by their predicate', () => {
    const rename = COMMANDS_SEARCH_REGISTRY.find(entry => entry.command === 'session.rename')!;
    expect(rename.available(FULL_CONTEXT)).toBe(true);
    expect(rename.available({ ...FULL_CONTEXT, hasActiveSession: false })).toBe(false);
    const panel3 = COMMANDS_SEARCH_REGISTRY.find(entry => entry.command === 'layout.togglePanel3')!;
    expect(panel3.available({ ...FULL_CONTEXT, inspectorAvailable: false })).toBe(false);
    const settings = COMMANDS_SEARCH_REGISTRY.find(entry => entry.command === 'app.settings')!;
    expect(settings.available({ ...FULL_CONTEXT, hasActiveSession: false, workbenchActive: false })).toBe(true);
  });

  it('matches the OTHER locale’s title regardless of the active one', () => {
    // zh title for the notifications section, queried on any locale.
    const zhTitle = ZH['settings.section.notifications']!;
    const matches = matchRegistryEntries(SETTINGS_SEARCH_REGISTRY, zhTitle, bothTitles);
    expect(matches.map(match => match.entry.navKey)).toContain('notifications');
  });

  it('control-level entries anchor to real rendered control ids', () => {
    const fontSize = SETTINGS_SEARCH_REGISTRY.find(entry => entry.id === 'chat.fontSize')!;
    expect(settingAnchorId(fontSize)).toBe('settings-control-chat.fontSize');
    const section = SETTINGS_SEARCH_REGISTRY.find(entry => entry.id === 'appearance')!;
    expect(settingAnchorId(section)).toBe('settings-section-appearance');
  });

  it('an empty or blank query matches nothing', () => {
    expect(matchRegistryEntries(SETTINGS_SEARCH_REGISTRY, '  ', bothTitles)).toEqual([]);
  });
});
