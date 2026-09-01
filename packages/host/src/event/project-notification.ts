import type { ChatDisplay, ChatEvent, DisplayEvent, Executor, ProxyNotification } from '@gian/shared';
import { proxyNotificationSchema } from '@gian/proxy-protocol';
import { decompileContextFromText } from '../session/context-items.js';
import { projectCcNotification } from './normalize-cc.js';
import { projectCodexNotification } from './normalize-codex.js';
import { projectKimiNotification } from './normalize-kimi.js';
import { projectProtocolV1Notification } from './normalize-protocol-v1.js';
import { projectProtocolV2Notification, type InteractionKindLookup } from './project-protocol-v2.js';

function isHistoricalProtocolV1(notification: ProxyNotification): boolean {
  const params = notification.params as Record<string, unknown> | undefined;
  return Boolean(
    params
    && typeof params.emittedAt === 'string'
    && typeof params.eventId === 'string'
    && typeof params.sessionId === 'string',
  );
}

function projectLegacyNotification(
  provider: Executor,
  notification: ProxyNotification,
  sessionId: string,
  turn: number,
): DisplayEvent[] {
  if (provider === 'claude') return projectCcNotification(notification, sessionId, turn);
  if (provider === 'codex') return projectCodexNotification(notification, sessionId, turn);
  return projectKimiNotification(notification, sessionId, turn);
}

/**
 * Keep a provider notification intact and attach zero or more UI projections.
 * `interactionKinds` supplies the pending interaction's native
 * optionId -> ACP permission kind map so resolved events can derive their
 * Gian decision before persistence; both live and replay callers pass the
 * same sequential registry.
 */
export function projectNotification(
  provider: Executor,
  notification: ProxyNotification,
  sessionId: string,
  turn: number,
  interactionKinds?: InteractionKindLookup,
): ChatEvent[] {
  const standard = proxyNotificationSchema.safeParse(notification);
  if (standard.success && standard.data.method === 'input.recorded') {
    const input = standard.data.params.data.input;
    const text = input
      .filter((item): item is Extract<typeof item, { type: 'text' }> => item.type === 'text')
      .map((item) => item.text)
      .join('\n\n');
    const data: Record<string, unknown> = { text, input };
    // Replayed provider history only carries the compiled text payload (fork,
    // native adopt, replay refresh). Recover the structured context fields so
    // reference chips render instead of raw GianReference/attachment markers.
    // Live user-typed text never matches the compiled format and stays as-is.
    const decompiled = decompileContextFromText(text);
    if (decompiled) {
      data.text = decompiled.text;
      if (decompiled.contextItems.length > 0) data.context_items = decompiled.contextItems;
      if (decompiled.document) data.composer_document = decompiled.document;
    }
    return [{
      session_id: sessionId,
      turn,
      call_id: standard.data.params.eventId,
      ts: Date.parse(standard.data.params.emittedAt),
      provider,
      event: 'user_message',
      data,
    }];
  }
  if (
    standard.success
    && (standard.data.method === 'step.updated' || standard.data.method === 'request.updated')
  ) {
    return [];
  }

  const projected: DisplayEvent[] = standard.success
    ? projectProtocolV2Notification(standard.data, sessionId, turn, interactionKinds)
    : (() => {
      const historical = isHistoricalProtocolV1(notification)
        ? (() => {
          try {
            return projectProtocolV1Notification(
              notification as Parameters<typeof projectProtocolV1Notification>[0],
              sessionId,
              turn,
            );
          } catch {
            return [];
          }
        })()
        : [];
      return historical.length > 0
        ? historical
        : projectLegacyNotification(provider, notification, sessionId, turn);
    })();

  const raw = notification.params?.data && typeof notification.params.data === 'object'
    ? notification.params.data as Record<string, unknown>
    : {};
  if (projected.length === 0) {
    if (notification.method === 'debug') return [];
    const nativeCallId = raw.activityId ?? raw.interactionId ?? raw.contentId ?? notification.params?.turnId;
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

  return projected.map((item) => ({
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
