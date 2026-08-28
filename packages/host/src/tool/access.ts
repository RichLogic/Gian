import type {
  GianToolCall,
  GianToolMethod,
  GianToolResult,
} from '@gian/shared';
import { isGianToolMutation } from '@gian/shared';
import type { Db } from '../storage/db.js';
import type { GianToolService } from './service.js';
import type { GianToolActor } from './credentials.js';

const TASK_MUTATIONS = new Set<GianToolMethod>(['task.create', 'task.update']);

interface OwnedSessionRow {
  id: string;
  task_id: string | null;
  created_by_actor_kind: string | null;
  created_by_actor_id: string | null;
}

function denied(requestId: string, message = 'Gian Tool capability does not allow this operation'): GianToolResult {
  return {
    ok: false,
    request_id: requestId,
    error: { code: 'PERMISSION_DENIED', message, retryable: false },
  };
}

function missing(requestId: string, message: string): GianToolResult {
  return {
    ok: false,
    request_id: requestId,
    error: { code: 'NOT_FOUND', message, retryable: false },
  };
}

function dataRecord(result: GianToolResult): Record<string, unknown> | null {
  return result.ok && result.data && typeof result.data === 'object' && !Array.isArray(result.data)
    ? result.data as Record<string, unknown>
    : null;
}

/** Applies trusted transport identity before entering the canonical Tool
 * service. Grants control visibility; role, direct ownership, Task state, and
 * the internal self-target invariant control authority. */
export class GianToolAccessController {
  constructor(
    private readonly service: GianToolService,
    private readonly db: Db,
  ) {}

  async call(
    actor: GianToolActor,
    call: Omit<GianToolCall, 'caller_id'>,
  ): Promise<GianToolResult> {
    if (actor.provisioning) {
      return denied(call.request_id, 'Gian Session identity is not active yet');
    }
    if (!actor.grants.includes(call.method)) return denied(call.request_id);
    let params = { ...(call.params as Record<string, unknown>) };

    if (TASK_MUTATIONS.has(call.method) && actor.role !== 'admin') {
      return denied(call.request_id, 'Task mutations require a Gian Tool administrator');
    }

    if (call.method === 'worktree.create_and_bind') {
      if (actor.kind !== 'internal_session') {
        return denied(call.request_id, 'Worktree self-context requires an internal Gian Session');
      }
    } else if (call.method === 'session.create') {
      const scoped = this.scopeCreate(actor, params, call.request_id);
      if (!scoped.ok) return scoped.result;
      params = scoped.params;
    } else if (call.method === 'interaction.list') {
      const explicit = typeof params['session_id'] === 'string' ? params['session_id'] : null;
      if (explicit) {
        const target = this.session(explicit);
        if (target && !this.canManage(actor, target)) {
          return denied(call.request_id, 'This actor cannot list interactions for that Session');
        }
      }
    } else if (isGianToolMutation(call.method) && !TASK_MUTATIONS.has(call.method)) {
      const targetId = this.mutationSessionId(call.method, params);
      if (call.method === 'session.cancel_delivery' && targetId === null) {
        return missing(call.request_id, `delivery not found: ${String(params['delivery_id'] ?? '')}`);
      }
      const target = targetId ? this.session(targetId) : null;
      if (target && !this.canManage(actor, target)) {
        return denied(call.request_id, 'This actor cannot mutate that Session');
      }
      if (call.method === 'session.assign_task' && actor.role !== 'admin') {
        const taskCheck = this.standardTaskTarget(actor, params['task_id']);
        if (taskCheck) return denied(call.request_id, taskCheck);
      }
    }

    const result = await this.service.call({
      ...call,
      caller_id: actor.callerId,
      params,
    }, { actor });
    return this.filterResult(actor, call.method, params, result);
  }

  private scopeCreate(
    actor: GianToolActor,
    params: Record<string, unknown>,
    requestId: string,
  ): { ok: true; params: Record<string, unknown> } | { ok: false; result: GianToolResult } {
    if (actor.role === 'admin') return { ok: true, params };
    if (actor.kind === 'internal_session' && actor.taskId) {
      if (params['task_id'] !== undefined && params['task_id'] !== actor.taskId) {
        return {
          ok: false,
          result: denied(requestId, 'Task-bound Sessions can create children only in their own Task'),
        };
      }
      return { ok: true, params: { ...params, task_id: actor.taskId } };
    }
    if (params['task_id'] !== undefined) {
      return {
        ok: false,
        result: denied(requestId, 'Unassigned standard actors cannot create Sessions in a Task'),
      };
    }
    return { ok: true, params };
  }

  private standardTaskTarget(actor: GianToolActor, targetTaskId: unknown): string | null {
    if (actor.kind === 'internal_session' && actor.taskId) {
      return targetTaskId === actor.taskId
        ? null
        : 'Task-bound Sessions can assign children only to their own Task';
    }
    return 'Unassigned standard actors cannot assign Sessions to a Task';
  }

  private mutationSessionId(
    method: GianToolMethod,
    params: Record<string, unknown>,
  ): string | null {
    if (method === 'session.cancel_delivery') {
      const deliveryId = params['delivery_id'];
      if (typeof deliveryId !== 'string') return null;
      const row = this.db.prepare(
        'SELECT session_id FROM tool_deliveries WHERE id = ?',
      ).get(deliveryId) as { session_id: string } | undefined;
      return row?.session_id ?? null;
    }
    return typeof params['session_id'] === 'string' ? params['session_id'] : null;
  }

  private session(id: string): OwnedSessionRow | null {
    return (this.db.prepare(
      `SELECT id, task_id, created_by_actor_kind, created_by_actor_id
         FROM sessions WHERE id = ?`,
    ).get(id) as OwnedSessionRow | undefined) ?? null;
  }

  private canManage(actor: GianToolActor, target: OwnedSessionRow): boolean {
    if (actor.kind === 'internal_session' && target.id === actor.sessionId) return false;
    if (actor.role === 'admin') return true;
    if (actor.kind === 'internal_session') {
      return target.created_by_actor_kind === 'internal_session'
        && target.created_by_actor_id === actor.sessionId;
    }
    return target.created_by_actor_kind === 'external_controller'
      && target.created_by_actor_id === actor.clientId;
  }

  private filterResult(
    actor: GianToolActor,
    method: GianToolMethod,
    params: Record<string, unknown>,
    result: GianToolResult,
  ): GianToolResult {
    const data = dataRecord(result);
    if (!data) return result;
    if (method === 'interaction.list' && Array.isArray(data['interactions'])) {
      return {
        ...result,
        data: {
          ...data,
          interactions: data['interactions'].filter((value) => {
            const sessionId = value && typeof value === 'object'
              ? (value as { session_id?: unknown }).session_id
              : undefined;
            const target = typeof sessionId === 'string' ? this.session(sessionId) : null;
            return !!target && this.canManage(actor, target);
          }),
        },
      };
    }
    const targetId = typeof params['session_id'] === 'string' ? params['session_id'] : null;
    const target = targetId ? this.session(targetId) : null;
    if (!target || this.canManage(actor, target)) return result;
    if (method === 'session.get' && Array.isArray(data['interactions'])) {
      return { ...result, data: { ...data, interactions: [] } };
    }
    if (method === 'session.wait' && Array.isArray(data['interactions'])) {
      return { ...result, data: { ...data, interactions: [] } };
    }
    if (method === 'session.read') {
      if (Array.isArray(data['events'])) {
        return {
          ...result,
          data: {
            ...data,
            events: data['events'].filter(value => !this.isPendingInteractionEvent(value)),
          },
        };
      }
      if (Array.isArray(data['turns'])) {
        return {
          ...result,
          data: {
            ...data,
            turns: data['turns'].map(value => this.withoutPendingTurnInteractions(value)),
          },
        };
      }
    }
    return result;
  }

  private isPendingInteractionEvent(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const display = (value as { display?: unknown }).display;
    if (!display || typeof display !== 'object') return false;
    const type = (display as { type?: unknown }).type;
    return type === 'interaction.approval' || type === 'interaction.question';
  }

  private withoutPendingTurnInteractions(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const turn = value as Record<string, unknown>;
    if (!Array.isArray(turn['interactions'])) return value;
    return {
      ...turn,
      interactions: turn['interactions'].filter(interaction => (
        !interaction || typeof interaction !== 'object'
          || (interaction as { status?: unknown }).status !== 'pending'
      )),
    };
  }
}
