/**
 * Side Chat and protocol Fork operation definitions. The Host owns opaque
 * resume references, route generations, and default id minting; the Web only
 * sends user-visible identities and exact Fork anchors.
 */
import type {
  SidechatCloseInput,
  SidechatCreateInput,
  SidechatResumeInput,
  SessionForkFromInput,
} from '@gian/shared';

import { registry } from './registry.js';
import type { OperationDefinition } from './types.js';

const WS_TIMEOUT_MS = 10_000;
const ATTACH_TIMEOUT_MS = 30_000;

export function sidechatEntityKey(sidechatId: string): string {
  return `sidechat:${sidechatId}`;
}

function freshPendingKey(name: string): string {
  return `pending:${name}:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

const sidechatCreate: OperationDefinition<SidechatCreateInput> = {
  policy: 'pending',
  entityKey: () => freshPendingKey('sidechat.create'),
  buildMessage: input => ({
    type: 'sidechat:create',
    parent_session_id: input.parentSessionId,
    ...(input.sidechatId ? { sidechat_id: input.sidechatId } : {}),
  }),
  timeoutMs: ATTACH_TIMEOUT_MS,
};

const sidechatResume: OperationDefinition<SidechatResumeInput> = {
  policy: 'pending',
  entityKey: input => sidechatEntityKey(input.sidechatId),
  buildMessage: input => ({
    type: 'sidechat:resume',
    sidechat_id: input.sidechatId,
    parent_session_id: input.parentSessionId,
  }),
  timeoutMs: ATTACH_TIMEOUT_MS,
};

const sidechatClose: OperationDefinition<SidechatCloseInput> = {
  policy: 'pending',
  entityKey: input => sidechatEntityKey(input.sidechatId),
  buildMessage: input => ({ type: 'sidechat:close', sidechat_id: input.sidechatId }),
  timeoutMs: WS_TIMEOUT_MS,
};

const sessionForkSession: OperationDefinition<SessionForkFromInput> = {
  policy: 'pending',
  entityKey: () => freshPendingKey('session.forkSession'),
  buildMessage: input => ({
    type: 'session:fork',
    source_session_id: input.sourceSessionId,
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
    anchor: input.anchor.type === 'head'
      ? { type: 'head' }
      : {
          type: 'turn',
          turn_id: input.anchor.turnId,
          source_turn_id: input.anchor.sourceTurnId,
        },
  }),
  timeoutMs: ATTACH_TIMEOUT_MS,
};

registry.register('sidechat.create', sidechatCreate);
registry.register('sidechat.resume', sidechatResume);
registry.register('sidechat.close', sidechatClose);
registry.register('session.forkSession', sessionForkSession);
