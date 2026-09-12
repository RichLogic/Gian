/**
 * Chat page (B5): transcript via `@gian/chat-ui` only — no simplified local
 * renderer. Connection banners sit above the transcript; while stale, the
 * transcript dims and never pretends to stream. Pending interactions render
 * as cards at the end of the transcript.
 */

import { useMemo } from 'react';
import {
  ChatPanelOpenContext,
  FileLinkHrefContext,
  FileLinkOpenContext,
  MessageAttachmentOpenContext,
  Transcript,
  renderChatItem,
} from '@gian/chat-ui';
import type { TranscriptItem } from '@gian/chat-ui';
import type { RemoteSession } from '@gian/remote-protocol';
import { mutationsEnabled } from '../controller/types.js';
import { useT } from '../i18n/index.js';
import { ConnectionBanner, UnknownOutcomeBanner } from './banners.js';
import { Composer } from './composer.js';
import { useRemoteActions, useRemoteState } from './controller-context.js';
import { interactionResponder, projectInteraction } from './interaction.js';
import { QueueCollapsedRow, QueueDrawer } from './queue.js';
import { useViewportMode } from './viewport.js';

export function ChatPage({ session }: { session: RemoteSession }) {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const mode = useViewportMode();

  const transcript = state.transcripts[session.id];
  const online = mutationsEnabled(state.connection);
  const stale = !online;

  const items = useMemo<TranscriptItem[]>(() => {
    const base = transcript?.items ?? [];
    const projected = state.interactions
      .filter((i) => i.session_id === session.id)
      .map((i) => {
        const phase = state.interactionPhases[i.id] ?? 'pending';
        const label =
          phase === 'resolved-here' ? t('interaction.resolvedHere')
          : phase === 'resolved-elsewhere' ? t('interaction.resolvedElsewhere')
          : phase === 'expired' ? t('interaction.expired')
          : undefined;
        return projectInteraction(i, phase, label);
      });
    return [...base, ...projected];
  }, [transcript, state.interactions, state.interactionPhases, session.id, t]);

  // A stale snapshot never looks live: suppress streaming affordances.
  const streaming = online && (transcript?.streaming ?? false);
  const responding = new Set(
    Object.entries(state.interactionPhases)
      .filter(([, phase]) => phase === 'responding')
      .map(([interactionId]) => interactionId),
  );

  return (
    <div className={`rw-chat-root${stale ? ' rw-stale' : ''}`}>
      <ConnectionBanner connection={state.connection} />
      {state.unknownCommandId && <UnknownOutcomeBanner commandId={state.unknownCommandId} />}
      <div className="main-scroll transcript-scroll">
        <div className="rw-chat">
          {!transcript?.hydrated && !transcript?.historyError && (
            <div className="rw-history-loading" role="status">
              <span className="spinner" aria-hidden="true" />
              {t('chat.history.loading')}
            </div>
          )}
          <FileLinkOpenContext.Provider
            value={(path) =>
              actions.openFile({ id: path, sessionId: session.id, label: path.split('/').pop() ?? path })
            }
          >
            <FileLinkHrefContext.Provider value={null}>
              <MessageAttachmentOpenContext.Provider
                value={(attachment) => actions.openFile({
                  id: attachment.url,
                  sessionId: session.id,
                  label: attachment.name,
                })}
              >
                <ChatPanelOpenContext.Provider value={null}>
                  <Transcript
                    items={items}
                    pending={streaming}
                    hydrated={transcript?.hydrated ?? false}
                    hasOlder={transcript?.hasOlder ?? false}
                    loadingOlder={transcript?.loadingOlder ?? false}
                    historyError={transcript?.historyError}
                    onLoadOlder={() => actions.loadOlderTranscript(session.id)}
                    onRetryHistory={() => actions.retryTranscript(session.id)}
                    onApprove={interactionResponder((interactionId, actionId, values) => {
                      if (!online || responding.has(interactionId)) return;
                      actions.respondToInteraction(interactionId, actionId, values);
                    })}
                    renderItem={(item, ctx) =>
                      renderChatItem(item, {
                        ...ctx,
                        // `responding` renders the card disabled with the
                        // resolving affordance until the canonical result lands.
                        isApprovalResolving: (approvalId) => responding.has(approvalId),
                      })
                    }
                  />
                </ChatPanelOpenContext.Provider>
              </MessageAttachmentOpenContext.Provider>
            </FileLinkHrefContext.Provider>
          </FileLinkOpenContext.Provider>
        </div>
      </div>
      <div className={mode === 'narrow' ? 'rw-m-bottom' : 'rw-bottom'}>
        {mode === 'narrow' ? <QueueCollapsedRow session={session} /> : <QueueDrawer session={session} />}
        <Composer session={session} />
        {stale && <div className="rw-offline-note">{t('chat.stale.note')}</div>}
      </div>
    </div>
  );
}
