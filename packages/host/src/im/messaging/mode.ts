import type { ApprovalMode, MessagingSession } from '../types.js';
import type { MessagingSessionMode } from './types.js';

// IM and web use Gian's same approval-mode vocabulary.

export function messagingSessionModeFromRecord(
  session: Pick<MessagingSession, 'approvalMode'>,
): MessagingSessionMode {
  return session.approvalMode;
}

export function messagingSessionModePreferences(mode: MessagingSessionMode): {
  approvalMode: ApprovalMode;
} {
  return { approvalMode: mode };
}
