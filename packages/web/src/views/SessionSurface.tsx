import type { Session, Workspace } from '@gian/shared';
import type { SessionCommands } from '../controllers/use-session-commands.js';
import {
  ChatPanelOpenContext,
} from '../presentation/chat-panel.js';
import type { ChatPanelRequest } from '../presentation/chat-panel.js';
import {
  DiffOpenContext,
  FileLinkOpenContext,
  FileRefRehypeContext,
  PlanOpenContext,
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
  pending: boolean;
  queue: QueueEntry[];
  planText?: string;
  planCompleted?: boolean;
  commands: SessionCommands;
  workingTreeId: string | null;
  branch: string | null;
  onOpenFile: (absolutePath: string, line?: number) => void;
  onOpenDiff: (item: DiffItem) => void;
  onOpenPlan: (payload: PlanOpenPayload) => void;
  onOpenChat: (request: ChatPanelRequest) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fileRehype: null | (() => (tree: any) => void);
  onShowChanges: () => void;
  onReopen?: () => void;
  containerClassName?: string;
}

export function SessionSurface({
  session,
  workspace,
  items,
  hydrated,
  pending,
  queue,
  planText,
  planCompleted,
  commands,
  workingTreeId,
  branch,
  onOpenFile,
  onOpenDiff,
  onOpenPlan,
  onOpenChat,
  fileRehype,
  onShowChanges,
  onReopen,
  containerClassName,
}: SessionSurfaceProps) {
  const content = (
    <FileLinkOpenContext.Provider value={onOpenFile}>
      <FileRefRehypeContext.Provider value={fileRehype}>
        <DiffOpenContext.Provider value={onOpenDiff}>
          <PlanOpenContext.Provider value={onOpenPlan}>
            <ChatPanelOpenContext.Provider value={onOpenChat}>
              <SessionMain
                session={session}
                workspace={workspace}
                items={items}
                hydrated={hydrated}
                pending={pending}
                queue={queue}
                planText={planText}
                codexPlanCompleted={planCompleted}
                onSend={(text, options) => commands.onSend(session.id, text, options)}
                onSendSkill={(name, path) => commands.onSendSkill(session.id, name, path)}
                onStop={() => commands.onStop(session.id)}
                onApprove={(approvalId, decision, answers, context) =>
                  commands.onApprove(session.id, approvalId, decision, answers, context)}
                onQueueAdd={(text, attachments) => commands.onQueueAdd(session.id, text, attachments)}
                onQueueRemove={queueId => commands.onQueueRemove(session.id, queueId)}
                onQueueReorder={order => commands.onQueueReorder(session.id, order)}
                onQueueClear={() => commands.onQueueClear(session.id)}
                onQueueSendNow={() => commands.onQueueSendNow(session.id)}
                onSteer={(text, options) => commands.onSteer(session.id, text, options?.attachments)}
                onSetMode={mode => commands.onSetMode(session.id, mode)}
                onSetModel={model => commands.onSetModel(session.id, model)}
                onSetEffort={effort => commands.onSetEffort(session.id, effort)}
                onSetServiceTier={tier => commands.onSetServiceTier(session.id, tier)}
                onSetNativeConfig={(configId, value) =>
                  commands.onSetNativeConfig(session.id, configId, value)}
                onDelete={() => commands.onDelete(session.id)}
                onReopen={onReopen}
                onShowChanges={onShowChanges}
                workingTreeId={workingTreeId}
                branch={branch}
              />
            </ChatPanelOpenContext.Provider>
          </PlanOpenContext.Provider>
        </DiffOpenContext.Provider>
      </FileRefRehypeContext.Provider>
    </FileLinkOpenContext.Provider>
  );

  return containerClassName ? <div className={containerClassName}>{content}</div> : content;
}
