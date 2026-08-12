import type { ChatDisplay, ChatEvent, DisplayEvent, Executor, ProxyNotification } from '@gian/shared';
import { proxyNotificationSchema } from '@gian/proxy-protocol';
import { projectCcNotification } from './normalize-cc.js';
import { projectCodexNotification } from './normalize-codex.js';
import { projectKimiNotification } from './normalize-kimi.js';
import { projectProtocolV1Notification } from './normalize-protocol-v1.js';

/**
 * Keep a provider notification intact and attach zero or more UI projections.
 * This is the only shared boundary a newly supported CLI needs to implement.
 */
export function projectNotification(
  provider: Executor,
  notification: ProxyNotification,
  sessionId: string,
  turn: number,
): ChatEvent[] {
  let projected: DisplayEvent[];
  const standard = proxyNotificationSchema.safeParse(notification);
  if (standard.success) {
    if (standard.data.method === 'input.recorded') {
      const input = standard.data.params.data.input;
      const text = input
        .filter((item): item is Extract<typeof item, { type: 'text' }> => item.type === 'text')
        .map(item => item.text)
        .join('\n\n');
      return [{
        session_id: sessionId,
        turn,
        call_id: standard.data.params.data.inputId,
        ts: Date.parse(standard.data.params.emittedAt),
        provider,
        event: 'user_message',
        data: { text, input },
      }];
    }
    projected = projectProtocolV1Notification(standard.data, sessionId, turn);
  } else if (provider === 'codex') {
    projected = projectCodexNotification(notification, sessionId, turn);
  } else if (provider === 'kimi') {
    projected = projectKimiNotification(notification, sessionId, turn);
  } else {
    projected = projectCcNotification(notification, sessionId, turn);
  }

  const raw = notification.params?.data && typeof notification.params.data === 'object'
    ? notification.params.data as Record<string, unknown>
    : {};
  if (projected.length === 0) {
    const nativeCallId = raw.callId ?? raw.itemId ?? notification.params?.turnId;
    return [{
      session_id: sessionId,
      turn,
      call_id: nativeCallId == null ? crypto.randomUUID() : String(nativeCallId),
      ts: Date.now(),
      provider,
      event: notification.method,
      data: raw,
    }];
  }

  return projected.map(item => ({
    session_id: item.session_id,
    turn: item.turn,
    call_id: item.call_id,
    ts: item.ts,
    provider,
    event: notification.method,
    data: raw,
    display: { type: item.type, data: item.data } as unknown as ChatDisplay,
  }));
}
