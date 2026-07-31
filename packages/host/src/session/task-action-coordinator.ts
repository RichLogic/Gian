import {
  MANAGER_SYS_CLOSE,
  MANAGER_SYS_OPEN,
  type Executor,
  type Session,
  type SubmitStepParams,
  type TaskAction,
  type TaskLoop,
} from '@gian/shared';
import { randomUUID } from 'node:crypto';
import { ActionExecutor, isTerminalStatus, type MessageOutcome } from '../task/action-executor.js';
import { parseGianAction } from '../task/action-parser.js';
import { advanceLoop } from '../task/loop-engine.js';
import {
  getActiveLoop,
  getLoop,
  insertLoop,
  updateLoop,
  type InsertLoopInput,
} from '../task/task-store.js';
import type { Db } from '../storage/db.js';
import type { CreateSessionInput } from './lifecycle-service.js';
import type { SessionHistoryStore } from './history-store.js';

interface TaskActionCallbacks {
  getSession(sessionId: string): Session;
  createSession(input: CreateSessionInput): Promise<Session>;
  broadcastCreated(session: Session): void;
  broadcastUpdated(sessionId: string, partial: Partial<Session>): void;
  sendMessage(sessionId: string, text: string): Promise<unknown>;
  enqueueMessage(sessionId: string, text: string): void;
  isBusy(sessionId: string): boolean;
}

export class TaskActionCoordinator {
  private executorInstance: ActionExecutor | null = null;

  constructor(
    private db: Db,
    private history: SessionHistoryStore,
    private callbacks: TaskActionCallbacks,
  ) {}

  private executor(): ActionExecutor {
    if (this.executorInstance) return this.executorInstance;
    this.executorInstance = new ActionExecutor(this.db, {
      resolveWorkspaceId: value => this.resolveWorkspaceId(value),
      createSubtask: input => this.createSubtask(input),
      messageSubtask: input => this.deliverToSubtask(input),
      writeStepSummary: input => this.writeStepSummary(input.session, input.params),
      onStepSubmitted: input => this.handleStepSubmitted(input.taskId, input.session, input.params),
    });
    return this.executorInstance;
  }

  processCompletedTurn(
    sessionId: string,
    turnId: string,
    explicitFinalText?: string,
  ): void {
    let session: Session;
    try {
      session = this.callbacks.getSession(sessionId);
    } catch {
      return;
    }
    if (!this.enabled(session) || !session.task_id) return;
    const finalText = explicitFinalText ?? this.history.finalAssistantText(turnId);
    if (!finalText) return;
    const parsed = parseGianAction(finalText);
    if (!parsed.ok) return;
    const record = this.executor().recordParsed({
      session,
      action: parsed.action,
      blockText: parsed.blockText,
      hostTurnId: turnId,
      sourceTurnKey: turnId,
    });
    if (!record || isTerminalStatus(record.status)
      || record.status === 'staged' || record.status === 'queued') return;
    void this.executor().driveRecorded(record.action_id, session).catch(error => {
      console.error(
        `[gian-task] action drive failed session=${session.id} action=${record.action_id}: ${(error as Error).message}`,
      );
    });
  }

  resumePending(): void {
    const rows = this.db.prepare(
      "SELECT action_id, session_id FROM task_actions WHERE status IN ('parsed','validated','authorized','executing')",
    ).all() as Array<{ action_id: string; session_id: string }>;
    for (const row of rows) {
      let session: Session;
      try {
        session = this.callbacks.getSession(row.session_id);
      } catch {
        continue;
      }
      if (!this.enabled(session)) continue;
      void this.executor().resume(row.action_id, session).catch(error => {
        console.error(`[gian-task] resume failed action=${row.action_id}: ${(error as Error).message}`);
      });
    }
  }

  startLoop(taskId: string, input: Omit<InsertLoopInput, 'id' | 'task_id'>): TaskLoop {
    if (!this.taskExists(taskId)) throw new Error(`task not found: ${taskId}`);
    const prior = getActiveLoop(this.db, taskId);
    if (prior) updateLoop(this.db, prior.id, { status: 'done' });
    const id = randomUUID();
    insertLoop(this.db, { id, task_id: taskId, ...input });
    return getLoop(this.db, id) as TaskLoop;
  }

  getLoop(taskId: string): TaskLoop | null {
    return getActiveLoop(this.db, taskId);
  }

  listActions(taskId: string): TaskAction[] {
    return this.db.prepare(
      'SELECT * FROM task_actions WHERE task_id = ? ORDER BY created_at DESC',
    ).all(taskId) as TaskAction[];
  }

  async confirm(taskId: string, actionId: string): Promise<TaskAction | null> {
    const row = this.db.prepare('SELECT * FROM task_actions WHERE action_id = ?')
      .get(actionId) as TaskAction | undefined;
    if (!row || row.task_id !== taskId) return null;
    return this.executor().confirmStaged(actionId, this.callbacks.getSession(row.session_id));
  }

  reject(taskId: string, actionId: string): TaskAction | null {
    const row = this.db.prepare('SELECT task_id FROM task_actions WHERE action_id = ?')
      .get(actionId) as { task_id: string } | undefined;
    if (!row || row.task_id !== taskId) return null;
    return this.executor().rejectStaged(actionId);
  }

  private enabled(session: Session): boolean {
    return process.env.GIAN_TASK_ROLES === '1' || session.type === 'manager';
  }

  private resolveWorkspaceId(nameOrPath: string): string | null {
    const row = this.db.prepare('SELECT id FROM workspaces WHERE name = ? OR path = ? LIMIT 1')
      .get(nameOrPath, nameOrPath) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private taskExists(taskId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId));
  }

  private async createSubtask(input: {
    taskId: string;
    workspaceId: string;
    executor: Executor;
    name?: string;
    brief: string;
  }): Promise<string> {
    const session = await this.callbacks.createSession({
      workspace_id: input.workspaceId,
      executor: input.executor,
      type: 'subtask',
      task_id: input.taskId,
      ...(input.name ? { name: input.name } : {}),
    });
    this.callbacks.broadcastCreated(session);
    await this.callbacks.sendMessage(session.id, input.brief);
    return session.id;
  }

  private async deliverToSubtask(input: {
    taskId: string;
    subtaskId: string;
    text: string;
  }): Promise<MessageOutcome> {
    let target: Session;
    try {
      target = this.callbacks.getSession(input.subtaskId);
    } catch {
      return 'failed';
    }
    if (target.task_id !== input.taskId || target.completed_at || target.worktree_outcome) {
      return 'failed';
    }
    if (this.callbacks.isBusy(input.subtaskId)) {
      this.callbacks.enqueueMessage(input.subtaskId, input.text);
      return 'queued';
    }
    try {
      await this.callbacks.sendMessage(input.subtaskId, input.text);
      return 'delivered';
    } catch {
      this.callbacks.enqueueMessage(input.subtaskId, input.text);
      return 'queued';
    }
  }

  private writeStepSummary(session: Session, params: SubmitStepParams): void {
    const verdict = params.verdict ? ` [${params.verdict}]` : '';
    const points = params.points?.length ? ` — ${params.points.join('; ')}` : '';
    const summary = `${params.headline}${verdict}${points}`.slice(0, 2000);
    const now = new Date().toISOString();
    this.db.prepare('UPDATE sessions SET summary = ?, updated_at = ? WHERE id = ?')
      .run(summary, now, session.id);
    this.callbacks.broadcastUpdated(session.id, { summary, updated_at: now });
  }

  private async handleStepSubmitted(
    taskId: string,
    session: Session,
    params: SubmitStepParams,
  ): Promise<void> {
    const loop = getActiveLoop(this.db, taskId);
    let loopNote = '';
    if (loop) {
      const decision = advanceLoop(loop, { status: params.status, verdict: params.verdict ?? null });
      updateLoop(this.db, loop.id, { status: decision.nextStatus, round: decision.nextRound });
      loopNote = `loop: ${decision.nextRound}/${loop.max_rounds || '∞'} (${decision.outcome})`;
    }
    await this.wakeManager(taskId, session, params, loopNote);
  }

  private async wakeManager(
    taskId: string,
    subtask: Session,
    params: SubmitStepParams,
    loopNote: string,
  ): Promise<void> {
    const manager = this.db.prepare(
      "SELECT * FROM sessions WHERE task_id = ? AND type = 'manager' AND archived = 0 LIMIT 1",
    ).get(taskId) as Session | undefined;
    if (!manager) return;
    const verdict = params.verdict ? `结论: ${params.verdict}` : `status: ${params.status}`;
    const points = params.points?.length ? `\n要点: ${params.points.join('; ')}` : '';
    const digest = [
      MANAGER_SYS_OPEN,
      '<<gian:subtask-done>>',
      `${subtask.name ?? subtask.id} [${subtask.executor}] 完成。${verdict}${points}`,
      loopNote,
      '请决定下一步。',
      '<</gian:subtask-done>>',
      MANAGER_SYS_CLOSE,
    ].filter(Boolean).join('\n');
    if (this.callbacks.isBusy(manager.id)) {
      this.callbacks.enqueueMessage(manager.id, digest);
    } else {
      await this.callbacks.sendMessage(manager.id, digest);
    }
  }
}
