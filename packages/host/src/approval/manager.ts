import { randomUUID } from 'node:crypto';
import type {
  ApprovalCategory,
  ApprovalDecision,
  ApprovalResolvedBy,
  ApprovalStatus,
} from '@gian/shared';
import type { WsBroadcaster } from '../web/ws-broadcast.js';

export interface ApprovalRequest {
  sessionId: string;
  turnId: string;
  category: ApprovalCategory;
  risk: 'low' | 'medium' | 'high';
  description: string;
  subject?: string;
  payload?: Record<string, unknown>;
}

export interface ApprovalRecord extends ApprovalRequest {
  id: string;
  status: ApprovalStatus;
  resolvedBy?: ApprovalResolvedBy;
  resolvedAt?: number;
  createdAt: number;
}

/**
 * Callback type for responding to proxies — injected by SessionManager to
 * avoid a circular import (ApprovalManager ↔ SessionManager would form a cycle
 * if we imported SessionManager directly).
 */
export type RespondApprovalFn = (
  sessionId: string,
  approvalId: string,
  decision: ApprovalDecision,
) => Promise<void>;

export type GetApprovalModeFn = (sessionId: string) => import('@gian/shared').ApprovalMode;

export class ApprovalManager {
  private pending = new Map<string, ApprovalRecord>();
  private sessionAllowed = new Map<string, Set<ApprovalCategory>>();
  private resolvers = new Map<string, (decision: ApprovalDecision) => void>();

  private respondFn: RespondApprovalFn | null = null;
  private getModeFn: GetApprovalModeFn | null = null;

  constructor(private broadcaster: WsBroadcaster) {}

  /**
   * Injected post-construction to break the circular dependency:
   * SessionManager → ApprovalManager → SessionManager.respondApproval.
   */
  setRespondFn(fn: RespondApprovalFn): void {
    this.respondFn = fn;
  }

  setGetModeFn(fn: GetApprovalModeFn): void {
    this.getModeFn = fn;
  }

  /**
   * Called from SessionManager.afterUnified for every approval_requested event.
   * Applies mode/risk/allow_session policy; auto-approves when appropriate,
   * otherwise registers as pending and waits for the user.
   */
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    const mode = this.getModeFn?.(req.sessionId) ?? 'ask';

    if (
      mode === 'auto' ||
      this.wasAllowedForSession(req.sessionId, req.category) ||
      req.risk === 'low'
    ) {
      return this.autoApprove(req);
    }

    return this.registerPending(req);
  }

  private async autoApprove(req: ApprovalRequest): Promise<ApprovalDecision> {
    const record: ApprovalRecord = {
      ...req,
      id: req.payload?.approvalId as string ?? randomUUID(),
      status: 'auto-approved',
      resolvedBy: 'auto',
      resolvedAt: Date.now(),
      createdAt: Date.now(),
    };

    this.broadcaster.broadcast({
      type: 'approval:created',
      approval: {
        id: record.id,
        session_id: record.sessionId,
        category: record.category,
        description: record.description,
        status: 'auto-approved',
      },
    });

    // Respond to the proxy immediately.
    try {
      await this.respondFn?.(req.sessionId, record.id, 'allow_once');
    } catch (err) {
      console.error('[approval] auto-approve respondFn failed', err);
    }

    return 'allow_once';
  }

  private registerPending(req: ApprovalRequest): Promise<ApprovalDecision> {
    const id = req.payload?.approvalId as string ?? randomUUID();
    const record: ApprovalRecord = {
      ...req,
      id,
      status: 'pending',
      createdAt: Date.now(),
    };
    this.pending.set(id, record);

    this.broadcaster.broadcast({
      type: 'approval:created',
      approval: {
        id,
        session_id: record.sessionId,
        category: record.category,
        description: record.description,
        status: 'pending',
      },
    });

    return new Promise<ApprovalDecision>(resolve => {
      this.resolvers.set(id, resolve);
    });
  }

  /**
   * Called by SessionManager.respondApproval after forwarding the decision to
   * the proxy. Updates state, broadcasts update, and resolves the pending
   * promise so the await in `request` can continue (if it was blocking).
   */
  resolve(approvalId: string, decision: ApprovalDecision, by: ApprovalResolvedBy): void {
    const record = this.pending.get(approvalId);
    if (!record) return;

    const status: ApprovalStatus =
      decision === 'allow_once' ? 'approved' :
      decision === 'allow_session' ? 'approved-session' :
      'declined';

    record.status = status;
    record.resolvedBy = by;
    record.resolvedAt = Date.now();
    this.pending.delete(approvalId);

    if (decision === 'allow_session') {
      const set = this.sessionAllowed.get(record.sessionId) ?? new Set();
      set.add(record.category);
      this.sessionAllowed.set(record.sessionId, set);
    }

    this.broadcaster.broadcast({
      type: 'approval:updated',
      approval: {
        id: approvalId,
        status,
        resolved_by: by,
        resolved_at: new Date(record.resolvedAt!).toISOString(),
      },
    });

    this.resolvers.get(approvalId)?.(decision);
    this.resolvers.delete(approvalId);
  }

  wasAllowedForSession(sessionId: string, category: ApprovalCategory): boolean {
    return this.sessionAllowed.get(sessionId)?.has(category) ?? false;
  }

  /** Look up a pending approval record by id (e.g. to inspect its category
   *  before forwarding the decision). Returns undefined if already resolved. */
  getPending(approvalId: string): ApprovalRecord | undefined {
    return this.pending.get(approvalId);
  }

  listPending(): ApprovalRecord[] {
    return [...this.pending.values()];
  }

  /**
   * Tear down all state for a session: resolves any pending request promises
   * with `decline`, drops them from the pending map, clears the
   * allow_session memo, and broadcasts `approval:updated` per record so the
   * UI doesn't keep stale cards (state_sync's `approvals` filter would
   * otherwise re-include them on reconnect).
   *
   * Called on `session:delete` and on proxy crash (handleProxyExit). Idempotent.
   */
  clearSession(sessionId: string): void {
    this.sessionAllowed.delete(sessionId);
    const now = Date.now();
    for (const [id, record] of [...this.pending]) {
      if (record.sessionId !== sessionId) continue;
      record.status = 'declined';
      record.resolvedBy = 'auto';
      record.resolvedAt = now;
      this.pending.delete(id);
      this.resolvers.get(id)?.('decline');
      this.resolvers.delete(id);
      this.broadcaster.broadcast({
        type: 'approval:updated',
        approval: {
          id,
          status: 'declined',
          resolved_by: 'auto',
          resolved_at: new Date(now).toISOString(),
        },
      });
    }
  }
}
