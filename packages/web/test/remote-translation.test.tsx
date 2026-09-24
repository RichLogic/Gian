import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Session } from '@gian/shared';
import { SessionMain } from '../src/views/SessionMain.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { translateText } from '../src/operations/translation.js';
import { remoteRequest } from '../src/remote-environments.js';
import { sessionContractFixture } from './fixtures/ws-contract.js';

vi.mock('../src/api.js', () => ({ loadAgents: vi.fn(async () => []), loadSessionTrace: vi.fn() }));
vi.mock('../src/remote-environments.js', () => ({ remoteRequest: vi.fn(async () => ({ status: 'ready' })) }));
vi.mock('../src/operations/translation.js', () => ({
  loadTranslationState: vi.fn(async () => ({ enabled: true, results: [], automatic: {},
    preferences: { sending_language: 'en', reading_language: 'zh-CN', agent_id: 'local-translator', model: 'luna' } })),
  translateText: vi.fn(async () => ({ id: 'local-translation-receipt' })),
  setAutoTranslation: vi.fn(), cancelTranslation: vi.fn(async () => {}),
}));
vi.mock('../src/components/Composer.js', () => ({
  discardComposerDraft: vi.fn(),
  Composer: ({ onSend }: { onSend: (text: string) => void }) => <button onClick={() => onSend('中文问题')}>Submit fixture</button>,
}));
vi.mock('../src/components/PlanChip.js', () => ({ PlanChip: () => null }));
vi.mock('../src/components/TurnDiffChip.js', () => ({ TurnDiffChip: () => null }));
vi.mock('../src/transcript/TranscriptMinimap.js', () => ({ TranscriptMinimap: () => null,
  TranscriptNavigation: () => <button>Navigation fixture</button> }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('enables the remote-session toggle and prepares translated sends through the local translation API', async () => {
  const onSend = vi.fn();
  const session = sessionContractFixture({ id: 'local-conversation', status: 'done',
    remote_execution: { environment_id: 'remote-environment', worktree_root: '/remote/repository' } as NonNullable<Session['remote_execution']>,
  });
  const noop = () => {};
  render(<LocaleProvider locale="en"><SessionMain
    session={session} workspace={null} items={[]} hydrated pending={false} queue={[]}
    onSend={onSend} onSendSkill={noop} onStop={noop} onApprove={noop}
    onQueueAdd={noop} onQueueRemove={noop} onQueueUpdate={noop} onQueueClear={noop} onQueueSendNow={noop}
    onSteer={noop} onSetMode={noop} onSetModel={noop} onSetEffort={noop} onSetServiceTier={noop}
    onSetNativeConfig={noop} onShowLastTurnChanges={noop}
  /></LocaleProvider>);
  await waitFor(() => expect(screen.getByRole('switch')).not.toBeDisabled());
  expect(screen.getByRole('switch')).toBeChecked();
  const underbar = screen.getByRole('switch').closest('.main-underbar')!;
  expect(underbar.textContent?.indexOf('Auto translate')).toBeLessThan(underbar.textContent!.indexOf('Navigation fixture'));
  fireEvent.click(screen.getByRole('button', { name: 'Submit fixture' }));
  await waitFor(() => expect(onSend).toHaveBeenCalledWith('中文问题', { translationId: 'local-translation-receipt' }));
  expect(translateText).toHaveBeenCalledWith('local-conversation', expect.objectContaining({ text: '中文问题', purpose: 'send' }),
    expect.any(AbortSignal), null);
  expect(vi.mocked(remoteRequest).mock.calls.every(([path]) => String(path).endsWith('/status'))).toBe(true);
});
