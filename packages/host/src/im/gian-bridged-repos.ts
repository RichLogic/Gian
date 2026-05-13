/**
 * IM 模块和 Gian 之间最大的数据建模分歧:rvc 把每个平台的 session 存在
 * `discord_coding_sessions` / `slack_coding_sessions` 表,Gian 用统一的
 * `sessions` 表。直接用 rvc 的 repository,IM 看到的 session 列表是空的
 * (Gian 里的 session 没被 mirror 进来),`/switch` 选完之后 manager 在
 * `loadCurrentWorkspaceContext` 里又重新读 rvc 的 session 表,什么也读不到。
 *
 * 这两个 wrapper 只 override session-related 方法,把它们 redirect 到
 * Gian 的 SessionManager。其他方法(bot CRUD、outbox、inbound events、
 * 已加入队列的 turn 等)还走 rvc 原本的 SQL 实现。
 *
 * Queue 方法目前仍走 rvc 的 `*_coding_queued_turns`(没和 Gian 的
 * `queue_entries` 桥接)—— Phase 8.x 再拉通,先解决 select session 不上的痛点。
 */

import type { SessionManager } from '../session/manager.js';
import { DiscordCodingRepository } from './discord/repository.js';
import { SlackCodingRepository } from './slack/repository.js';
import {
  gianSessionToRvcRecord,
} from './build-options.js';
import type { SessionRecord } from './types.js';

interface BridgeDeps {
  sessions: SessionManager;
}

function loadSession(deps: BridgeDeps, sessionId: string): SessionRecord | null {
  try {
    const s = deps.sessions.getSession(sessionId);
    return gianSessionToRvcRecord(s);
  } catch {
    return null;
  }
}

function listSessionsByWorkspace(
  deps: BridgeDeps,
  workspaceId: string,
): SessionRecord[] {
  return deps.sessions
    .listSessions()
    .filter(s => s.workspace_id === workspaceId)
    .map(gianSessionToRvcRecord);
}

function listAllSessions(deps: BridgeDeps): SessionRecord[] {
  return deps.sessions.listSessions().map(gianSessionToRvcRecord);
}

function applySessionPatch(
  deps: BridgeDeps,
  sessionId: string,
  patch: Partial<SessionRecord>,
): void {
  // Gian's SessionManager exposes individual setters per field. Walk the
  // rvc patch and translate each known field to the matching Gian setter.
  // Fields rvc cares about that Gian doesn't track (`botId`, `threadId`,
  // `securityProfile`, `executionMode`, `job`, `archivedAt` to non-null
  // when we want soft-archive only) are silently ignored.
  if (patch.model !== undefined && patch.model !== null) {
    deps.sessions.setModel(sessionId, patch.model);
  }
  if (patch.reasoningEffort !== undefined) {
    const effort = patch.reasoningEffort;
    // rvc 'none' → null in Gian; rest map 1:1 except 'xhigh' (kept as-is).
    const gianEffort = effort === 'none' ? null
      : effort === 'minimal' ? 'minimal'
      : effort === 'low' ? 'low'
      : effort === 'medium' ? 'medium'
      : effort === 'high' ? 'high'
      : effort === 'xhigh' ? 'xhigh'
      : null;
    deps.sessions.setEffort(sessionId, gianEffort);
  }
  if (patch.approvalMode !== undefined) {
    // IM ApprovalMode is now Gian's vocabulary natively ('plan'|'ask'|'auto').
    deps.sessions.setApprovalMode(sessionId, patch.approvalMode);
  }
  if (patch.archivedAt) {
    // Any non-null archivedAt → archive in Gian.
    deps.sessions.archiveSession(sessionId, true);
  }
  if (patch.title) {
    deps.sessions.renameSession(sessionId, patch.title);
  }
}

export class GianBridgedDiscordRepository extends DiscordCodingRepository {
  constructor(db: ConstructorParameters<typeof DiscordCodingRepository>[0], private readonly bridge: BridgeDeps) {
    super(db);
  }

  override async getSession(sessionId: string): Promise<SessionRecord | null> {
    return loadSession(this.bridge, sessionId);
  }

  override async getSessionForUser(sessionId: string, _userId: string): Promise<SessionRecord | null> {
    return loadSession(this.bridge, sessionId);
  }

  override async getSessionForBot(_botId: string, sessionId: string): Promise<SessionRecord | null> {
    return loadSession(this.bridge, sessionId);
  }

  override async getSessionForBotWorkspace(_botId: string, workspaceId: string): Promise<SessionRecord | null> {
    const list = listSessionsByWorkspace(this.bridge, workspaceId);
    return list[0] ?? null;
  }

  override async listSessionsForOwnerWorkspace(_userId: string, workspaceId: string): Promise<SessionRecord[]> {
    return listSessionsByWorkspace(this.bridge, workspaceId);
  }

  override async listSessionsForUser(_userId: string): Promise<SessionRecord[]> {
    return listAllSessions(this.bridge);
  }

  override async listSessionsForBot(_botId: string): Promise<SessionRecord[]> {
    return listAllSessions(this.bridge);
  }

  override async listSessionsForBotWorkspace(_botId: string, workspaceId: string): Promise<SessionRecord[]> {
    return listSessionsByWorkspace(this.bridge, workspaceId);
  }

  override async updateSession(sessionId: string, patch: Partial<SessionRecord>): Promise<SessionRecord | null> {
    applySessionPatch(this.bridge, sessionId, patch);
    return loadSession(this.bridge, sessionId);
  }
}

export class GianBridgedSlackRepository extends SlackCodingRepository {
  constructor(db: ConstructorParameters<typeof SlackCodingRepository>[0], private readonly bridge: BridgeDeps) {
    super(db);
  }

  // Slack base class has fewer session-listing methods than Discord; only
  // override what's actually defined to avoid TS4117 (override-without-base).

  override async getSession(sessionId: string): Promise<SessionRecord | null> {
    return loadSession(this.bridge, sessionId);
  }

  override async getSessionForUser(sessionId: string, _userId: string): Promise<SessionRecord | null> {
    return loadSession(this.bridge, sessionId);
  }

  override async getSessionForBot(_botId: string, sessionId: string): Promise<SessionRecord | null> {
    return loadSession(this.bridge, sessionId);
  }

  override async listSessionsForOwnerWorkspace(_userId: string, workspaceId: string): Promise<SessionRecord[]> {
    return listSessionsByWorkspace(this.bridge, workspaceId);
  }

  override async listSessionsForUser(_userId: string): Promise<SessionRecord[]> {
    return listAllSessions(this.bridge);
  }

  override async updateSession(sessionId: string, patch: Partial<SessionRecord>): Promise<SessionRecord | null> {
    applySessionPatch(this.bridge, sessionId, patch);
    return loadSession(this.bridge, sessionId);
  }
}
