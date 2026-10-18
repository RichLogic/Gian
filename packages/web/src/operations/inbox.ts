import type { InboxItemPublic } from '@gian/shared';
import { InboxApiError, markInboxRead as postRead, markInboxUnread as postUnread, skipInboxVersion as postSkip } from '../api.js';
import type { OperationDispatcher } from './dispatcher.js';
import { registry } from './registry.js';
import type { OperationDefinition } from './types.js';
import { waitForRunSettle } from './use-operations.js';

interface Occurrence { id: string; generation: number }
interface SkipVersion extends Occurrence { version: string }
type InboxOperation = 'inbox.markRead' | 'inbox.markUnread' | 'inbox.skipVersion';
const entityKey = (input: Occurrence) => `inbox:${JSON.stringify([input.id, input.generation])}`;

const markRead: OperationDefinition<Occurrence, InboxItemPublic> = {
  policy: 'pending', entityKey, timeoutMs: 30_000,
  execute: input => postRead(input.id, input.generation),
};
const markUnread: OperationDefinition<Occurrence, InboxItemPublic> = {
  policy: 'pending', entityKey, timeoutMs: 30_000,
  execute: input => postUnread(input.id, input.generation),
};
const skipVersion: OperationDefinition<SkipVersion, InboxItemPublic> = {
  policy: 'pending',
  entityKey: input => `${entityKey(input)}:${JSON.stringify(input.version)}`,
  timeoutMs: 30_000,
  execute: input => postSkip(input.id, input.generation, input.version),
};
registry.register('inbox.markRead', markRead);
registry.register('inbox.markUnread', markUnread);
registry.register('inbox.skipVersion', skipVersion);

let binding: { dispatcher: OperationDispatcher; onUnknown: () => void } | null = null;

export function wireInboxOperations(dispatcher: OperationDispatcher, onUnknown: () => void): () => void {
  const owner = { dispatcher, onUnknown };
  binding = owner;
  return () => { if (binding === owner) binding = null; };
}

async function perform(name: InboxOperation, input: Occurrence | SkipVersion): Promise<InboxItemPublic> {
  const owner = binding;
  if (!owner) throw new Error('Inbox operations are unavailable.');
  const { dispatcher } = owner;
  const run = dispatcher.dispatch(name, input);
  // Join the actual run: duplicate pending calls share one POST and both
  // callers settle, including when a timeout leaves the outcome unknown.
  const settled = await waitForRunSettle(dispatcher.store, run.id);
  if (settled.phase === 'confirmed') return settled.result as InboxItemPublic;
  if (settled.phase === 'timed-out') owner.onUnknown();
  throw new InboxApiError({
    code: settled.errorCode ?? 'inbox_outcome_unknown',
    message: settled.error ?? 'Inbox operation outcome is unknown.',
    status: settled.errorCode === 'stale' ? 409 : 0,
  });
}

export const markInboxRead = (id: string, generation: number): Promise<InboxItemPublic> =>
  perform('inbox.markRead', { id, generation });
export const markInboxUnread = (id: string, generation: number): Promise<InboxItemPublic> =>
  perform('inbox.markUnread', { id, generation });
export const skipInboxVersion = (id: string, generation: number, version: string): Promise<InboxItemPublic> =>
  perform('inbox.skipVersion', { id, generation, version });
