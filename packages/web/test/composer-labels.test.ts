import { describe, expect, it } from 'vitest';
import type { CcModelCapabilities, CodexModelCapabilities } from '@gian/shared';
import {
  claudeModelFamily,
  defaultEffort,
  defaultModel,
  modelLabel,
  supportedEfforts,
} from '../src/components/composer/capabilities.js';

const claude: CcModelCapabilities = {
  id: 'sonnet',
  model: 'claude-sonnet-4-20250514',
  displayName: 'Sonnet 4',
  description: '',
  hidden: false,
  isDefault: false,
  supportedEfforts: ['low', 'high'],
  defaultEffort: 'high',
};

const defaultClaude: CcModelCapabilities = {
  ...claude,
  id: 'opus',
  model: 'claude-opus-4-20250514',
  displayName: 'Opus 4',
  isDefault: true,
};

const codex: CodexModelCapabilities = {
  id: 'codex',
  model: 'gpt-5-codex',
  displayName: 'GPT-5 Codex',
  description: '',
  hidden: false,
  isDefault: true,
  supportedThinking: ['low', null] as CodexModelCapabilities['supportedThinking'],
  defaultThinking: null,
};

describe('claudeModelFamily', () => {
  it('extracts opus/sonnet/haiku or returns the raw id', () => {
    expect(claudeModelFamily('claude-sonnet-4-20250514')).toBe('sonnet');
    expect(claudeModelFamily('claude-opus-4')).toBe('opus');
    expect(claudeModelFamily('claude-haiku-3')).toBe('haiku');
    expect(claudeModelFamily('gpt-5')).toBe('gpt-5');
  });
});

describe('defaultModel / modelLabel', () => {
  it('prefers isDefault then first, and falls back per executor', () => {
    expect(defaultModel([claude, defaultClaude], 'claude')).toBe(defaultClaude.model);
    expect(defaultModel([], 'codex')).toBe('gpt-5-codex');
    expect(defaultModel([], 'claude')).toBe('');
    expect(modelLabel([claude], claude.model)).toBe('Sonnet 4');
    expect(modelLabel([claude], 'missing')).toBe('missing');
  });
});

describe('supportedEfforts / defaultEffort', () => {
  it('reads Claude effort fields and Codex thinking fields', () => {
    expect(supportedEfforts(undefined)).toEqual([]);
    expect(supportedEfforts(claude)).toEqual(['low', 'high']);
    expect(supportedEfforts(codex)).toEqual(['low', 'off']);
    expect(defaultEffort(undefined)).toBeNull();
    expect(defaultEffort(claude)).toBe('high');
    expect(defaultEffort(codex)).toBe('off');
  });
});
