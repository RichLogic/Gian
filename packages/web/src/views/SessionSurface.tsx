import type { Session, Workspace } from '@gian/shared';
import type { SessionCommands } from '../controllers/use-session-commands.js';
import type { TranscriptHistoryState } from '../controllers/use-transcript-hydration.js';
import type { ActionControlState } from '../components/action-gating.js';
import {
  ChatPanelOpenContext,
} from '../presentation/chat-panel.js';
import type { ChatPanelRequest } from '../presentation/chat-panel.js';
import {
  DiffOpenContext,
  FileLinkOpenContext,
  FileRefRehypeContext,
  PlanOpenContext,
  RelativeLinkOpenContext,
} from '../transcript/items.js';
import type { PlanOpenPayload } from '../transcript/items.js';
import type { DiffItem, QueueEntry, TranscriptItem } from '../types.js';
import { SessionMain } from './SessionMain.js';

interface SessionSurfaceProps {
  session: Session;
  workspace: Workspace | null;
  items: TranscriptItem[];
  /** False while the session's history is still loading — suppresses the
   *  transcript empty state so switching sessions doesn't flash it. */
  hydrated?: boolean;
  history?: TranscriptHistoryState;
  onLoadOlder?: () => void;
  onRetryHistory?: () => void;
  pending: boolean;
  queue: QueueEntry[];
  planText?: string;
  planCompleted?: boolean;
  planStatus?: 'active' | 'paused' | 'completed';
  planTurn?: number;
  commands: SessionCommands;
  workingTreeId: string | null;
  branch: string | null;
  onOpenFile: (absolutePath: string, line?: number) => void;
  /** Click-time fallback for relative markdown links the render-time linkify
   *  pass didn't resolve (see RelativeLinkOpenContext). */
  onOpenRelativeFile: (href: string) => void;
  onOpenDiff: (item: DiffItem) => void;
  onOpenPlan: (payload: PlanOpenPayload) => void;
  onOpenChat: (request: ChatPanelRequest) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fileRehype: null | (() => (tree: any) => void);
  onShowChanges: () => void;
  /** Opens a selected file in Diffs pinned to the card's Last-turn scope. */
  onShowLastTurnChanges: (turn: number, path: string) => void;
  onReopen?: () => void;
  containerClassName?: string;
  /** Session Fork standard controls (proposal §10.6) — same contract as
   *  SessionMain (head fork lives in the session dropdown menu; Side Chat
   *  lives on the Dock rail + panel 2). */
  forkAtTurnControl?: ActionControlState | null;
  originParentName?: string;
}

export function SessionSurface({
  session,
  workspace,
  items,
  hydrated,
  history,
  onLoadOlder,
  onRetryHistory,
  pending,
  queue,
  planText,
  planCompleted,
  planStatus,
  planTurn,
  commands,
  workingTreeId,
  branch,
  onOpenFile,
  onOpenRelativeFile,
  onOpenDiff,
  onOpenPlan,
  onOpenChat,
  fileRehype,
  onShowChanges,
  onShowLastTurnChanges,
  onReopen,
  containerClassName,
  forkAtTurnControl,
  originParentName,
}: SessionSurfaceProps) {
  const content = (
    <FileLinkOpenContext.Provider value={onOpenFile}>
      <RelativeLinkOpenContext.Provider value={onOpenRelativeFile}>
      <FileRefRehypeContext.Provider value={fileRehype}>
        <DiffOpenContext.Provider value={onOpenDiff}>
          <PlanOpenContext.Provider value={onOpenPlan}>
            <ChatPanelOpenContext.Provider value={onOpenChat}>
              <SessionMain
                key={session.id}
                session={session}
                workspace={workspace}
                items={items}
                hydrated={hydrated}
                history={history}
                onLoadOlder={onLoadOlder}
                onRetryHistory={onRetryHistory}
                pending={pending}
                queue={queue}
                planText={planText}
                codexPlanCompleted={planCompleted}
                codexPlanStatus={planStatus}
                codexPlanTurn={planTurn}
                onSend={(text, options) => commands.onSend(session.id, text, options)}
                onSendSkill={(name, path) => commands.onSendSkill(session.id, name, path)}
                onStop={() => commands.onStop(session.id)}
                onApprove={(approvalId, decision, answers, context) =>
                  commands.onApprove(session.id, approvalId, decision, answers, context)}
                onQueueAdd={(text, attachments) => commands.onQueueAdd(session.id, text, attachments)}
                onQueueRemove={queueId => commands.onQueueRemove(session.id, queueId)}
                onQueueUpdate={(queueId, text) => commands.onQueueUpdate(session.id, queueId, text)}
                onQueueClear={() => commands.onQueueClear(session.id)}
                onQueueSendNow={() => commands.onQueueSendNow(session.id)}
                onSteer={(text, options) => commands.onSteer(session.id, text, options?.attachments)}
                onSetMode={mode => commands.onSetMode(session.id, mode)}
                onSetModel={model => commands.onSetModel(session.id, model)}
                onSetEffort={effort => commands.onSetEffort(session.id, effort)}
                onSetServiceTier={tier => commands.onSetServiceTier(session.id, tier)}
                onSetNativeConfig={(configId, value) =>
                  commands.onSetNativeConfig(session.id, configId, value)}
                onSetTurnConfig={(optionId, value) =>
                  commands.onSetTurnConfig(session.id, optionId, value, {
                    ...(session.turn_config ?? {}),
                    [optionId]: value,
                  })}
                onDelete={() => commands.onDelete(session.id)}
                onReopen={onReopen}
                onShowChanges={onShowChanges}
                onShowLastTurnChanges={onShowLastTurnChanges}
                workingTreeId={workingTreeId}
                branch={branch}
                forkAtTurnControl={forkAtTurnControl}
                originParentName={originParentName}
              />
            </ChatPanelOpenContext.Provider>
          </PlanOpenContext.Provider>
        </DiffOpenContext.Provider>
      </FileRefRehypeContext.Provider>
      </RelativeLinkOpenContext.Provider>
    </FileLinkOpenContext.Provider>
  );

  return containerClassName ? <div className={containerClassName}>{content}</div> : content;
}
