import type { ConfigValue } from './model.js';
import type { SideChatPublicSnapshot, SessionOrigin } from './sidechat.js';

export const SIDECHAT_OPERATION_POLICIES = {
  'sidechat.create': 'pending',
  'sidechat.resume': 'pending',
  'sidechat.close': 'pending',
  'sidechat.setTurnConfig': 'optimistic',
  'session.forkSession': 'pending',
} as const;

export type SidechatOperationName = keyof typeof SIDECHAT_OPERATION_POLICIES;

export interface SidechatCreateInput {
  parentSessionId: string;
  sidechatId?: string;
}

export interface SidechatCreateResult {
  sidechat: SideChatPublicSnapshot;
}

export interface SidechatResumeInput {
  sidechatId: string;
  parentSessionId: string;
}

export interface SidechatResumeResult {
  sidechat: SideChatPublicSnapshot;
}

export interface SidechatCloseInput {
  sidechatId: string;
}

export interface SidechatSetTurnConfigInput {
  sidechatId: string;
  optionId: string;
  value: ConfigValue;
  turnConfig: Record<string, ConfigValue>;
}

export interface SidechatCloseResult {
  ok: true;
  sidechatId: string;
  providerDataDeleted: boolean;
}

export type SessionForkFromAnchor =
  | { type: 'head' }
  | { type: 'turn'; turnId: string; sourceTurnId: string };

export interface SessionForkFromInput {
  sourceSessionId: string;
  sessionId?: string;
  anchor: SessionForkFromAnchor;
  turnConfig?: Record<string, ConfigValue>;
}

export interface SessionForkFromResult {
  sessionId: string;
  origin: SessionOrigin;
}
