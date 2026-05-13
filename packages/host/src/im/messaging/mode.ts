import type { ApprovalMode, SessionExecutionMode, SessionRecord } from '../types.js';
import type { MessagingSessionMode } from './types.js';

// IM mode == Gian ApprovalMode 1:1 ('plan' | 'ask' | 'auto').
// (Originally rvc projected three → two and used different labels; we
//  realigned in im/types.ts so IM and web speak the same vocabulary.)

export function messagingSessionModeFromRecord(
  session: Pick<SessionRecord, 'approvalMode' | 'executionMode'>,
): MessagingSessionMode {
  return session.approvalMode;
}

export function messagingSessionModePreferences(mode: MessagingSessionMode): {
  approvalMode: ApprovalMode;
  executionMode: SessionExecutionMode;
} {
  return {
    approvalMode: mode,
    executionMode: 'interactive',
  };
}
