/**
 * Shared Inbox fixtures for the web tests (Issue #53 / 0.6.7). Builders
 * produce contract-complete `InboxItemPublic` rows (shared/inbox.ts key sets
 * are exact).
 */
import type { InboxItemPublic } from '@gian/shared';
import { invalidateInbox } from '../src/controllers/inbox.js';
import { createOperationDispatcher } from '../src/operations/dispatcher.js';
import { wireInboxOperations } from '../src/operations/inbox.js';

export function wireTestInboxOperations(): () => void {
  const dispatcher = createOperationDispatcher();
  const unwire = wireInboxOperations(dispatcher, invalidateInbox);
  return () => { unwire(); dispatcher.dispose(); };
}

export function makeInboxItem(overrides: Partial<InboxItemPublic> = {}): InboxItemPublic {
  return {
    id: 'inbox-1',
    source_kind: 'session.question',
    status: 'pending',
    generation: 1,
    revision: 1,
    unread: true,
    read_at: null,
    title: 'Deploy to production?',
    summary: 'The agent asked a question.',
    target: { type: 'session', session_id: 's-1', turn: 2, interaction_id: 'int-1' },
    display: { kind: 'session.question', interaction_id: 'int-1' },
    actions: ['open', 'answer', 'cancel'],
    created_at: '2026-10-12T01:00:00.000Z',
    updated_at: '2026-10-12T01:00:00.000Z',
    closed_at: null,
    ...overrides,
  };
}
