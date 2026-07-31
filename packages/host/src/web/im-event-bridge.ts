import type { UnifiedEvent } from '@gian/shared';
import type { ApprovalManager } from '../approval/index.js';
import { toMessagingSession, toPendingApproval } from '../im/build-options.js';
import type { MessagingPlatform } from '../im/messaging/types.js';
import type { CodexThread } from '../im/types.js';
import type { SessionManager } from '../session/manager.js';
import type { Db } from '../storage/db.js';

export async function fanIMEvent(
  event: UnifiedEvent,
  db: Db,
  sessions: SessionManager,
  approvals: ApprovalManager,
  platforms: MessagingPlatform[],
): Promise<void> {
  const session = (() => {
    try {
      return sessions.getSession(event.session_id);
    } catch {
      return null;
    }
  })();
  if (!session || session.executor === 'kimi') return;

  const workspace = db.prepare('SELECT path FROM workspaces WHERE id = ?')
    .get(session.workspace_id) as { path: string } | undefined;
  const messagingSession = toMessagingSession(session, workspace?.path);

  if (event.type === 'turn_completed') {
    const data = event.data as { turnId?: string; summary?: string };
    const turnId = data.turnId ?? event.call_id;
    const thread: CodexThread = {
      id: session.native_session_id ?? session.id,
      preview: '',
      cwd: '',
      name: session.name ?? null,
      status: 'completed',
      updatedAt: Date.now(),
      turns: [{
        id: turnId,
        status: 'completed',
        error: null,
        items: data.summary
          ? [{ type: 'agentMessage', id: turnId, text: data.summary, phase: null }]
          : [],
      }],
    };
    await Promise.all(platforms.map(platform =>
      platform.sendTurnCompletion(messagingSession, thread, turnId).catch(error => {
        console.error(`[im] ${platform.platformId} sendTurnCompletion failed`, error);
      }),
    ));
    return;
  }

  if (event.type === 'approval_requested') {
    const approvalId = (event.data as { approvalId?: string }).approvalId ?? '';
    const record = approvalId ? approvals.getPending(approvalId) : null;
    if (!record) return;
    const pending = toPendingApproval(record, session.executor);
    await Promise.all(platforms.map(platform =>
      platform.sendApprovalRequested(messagingSession, pending).catch(error => {
        console.error(`[im] ${platform.platformId} sendApprovalRequested failed`, error);
      }),
    ));
    return;
  }

  if (event.type === 'session_error') {
    const message = (event.data as { message?: string }).message ?? 'Session error';
    await Promise.all(platforms.map(platform =>
      platform.sendSessionError(messagingSession, message).catch(error => {
        console.error(`[im] ${platform.platformId} sendSessionError failed`, error);
      }),
    ));
  }
}
