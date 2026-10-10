import { MAX_NDJSON_LINE_BYTES } from '@gian/proxy-protocol';
import type {
  InboxApprovalCategory,
  InboxRepairScope,
  InboxUpdatePhase,
} from '@gian/shared';

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TEXT = 280;

export type InboxActor = 'user' | 'system';
export type InboxTerminalOutcome = 'resolved' | 'rejected' | 'cancelled' | 'expired';

export class InboxSignalError extends Error {
  readonly code = 'INVALID_SOURCE' as const;

  constructor(message: string) {
    super(message);
    this.name = 'InboxSignalError';
  }
}

interface QuestionFields {
  interaction_id: string;
  session_id: string;
  turn: number | null;
  generation: number;
  title: string;
  summary: string;
}

interface ApprovalFields extends QuestionFields {
  category: InboxApprovalCategory;
}

export type InboxSignal =
  | { kind: 'session.turn_completed' }
  | { kind: 'session.turn_failed' }
  | { kind: 'session.stopped' }
  | { kind: 'session.retry' }
  | { kind: 'session.streaming' }
  | ({ kind: 'session.question' } & QuestionFields)
  | ({ kind: 'session.approval' } & ApprovalFields)
  | {
      kind: 'session.question.closed';
      interaction_id: string;
      session_id: string;
      generation: number;
      outcome: Exclude<InboxTerminalOutcome, 'rejected'>;
      actor: InboxActor;
    }
  | {
      kind: 'session.approval.closed';
      interaction_id: string;
      session_id: string;
      generation: number;
      outcome: InboxTerminalOutcome;
      actor: InboxActor;
      /** Required only when the close creates the row. An existing row keeps its category. */
      category?: InboxApprovalCategory;
    }
  | {
      kind: 'system.repair';
      scope: InboxRepairScope;
      subject_id: string;
      fault_generation: number;
      title: string;
      summary: string;
    }
  | {
      kind: 'system.repair.closed';
      scope: InboxRepairScope;
      subject_id: string;
      fault_generation: number;
      outcome: 'resolved' | 'cancelled' | 'expired';
      actor: InboxActor;
    }
  | {
      kind: 'system.pairing';
      request_id: string;
      generation: number;
      title: string;
      summary: string;
    }
  | {
      kind: 'system.pairing.closed';
      request_id: string;
      generation: number;
      outcome: InboxTerminalOutcome;
      actor: InboxActor;
    }
  | {
      kind: 'product.update';
      product: 'gian' | 'integration';
      target_id: string;
      version: string;
      channel: string;
      /** Producer freshness. Service-owned generation is not this number. */
      epoch: number;
      phase: InboxUpdatePhase;
      title: string;
      summary: string;
    }
  | {
      kind: 'product.update.closed';
      product: 'gian' | 'integration';
      target_id: string;
      version: string;
      channel: string;
      /** Inbox generation the producer observed for this candidate. */
      generation: number;
      epoch: number;
      outcome: 'resolved' | 'cancelled' | 'expired';
      actor: InboxActor;
    };

const IGNORED = new Set([
  'session.turn_completed',
  'session.turn_failed',
  'session.stopped',
  'session.retry',
  'session.streaming',
]);

const APPROVAL_CATEGORIES = new Set(['command', 'permission', 'browser', 'plan', 'schedule']);
const REPAIR_SCOPES = new Set(['account', 'runtime', 'schedule']);
const PHASES = new Set(['available', 'downloaded', 'failed']);
const USER_OUTCOMES = new Set(['resolved', 'rejected', 'cancelled', 'expired']);

function fail(message: string): never {
  throw new InboxSignalError(message);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('signal must be an object');
  return value as Record<string, unknown>;
}

function ident(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID.test(value)) fail(`${field} is not a bounded identifier`);
  return value;
}

/** Provider interaction ids are opaque: the proxy protocol accepts any
 *  non-empty string, so the Inbox must not invent a narrower Provider contract.
 *  The id already arrived inside one protocol message, so the total message
 *  cap is the only size bound. The original value is stored and returned to
 *  the Provider unchanged; Inbox source keys are length-prefixed, so slash,
 *  space, non-ascii, over-1024, and NUL values cannot collide or corrupt a key.
 *  Only empty and non-string values are rejected (the protocol rejects them
 *  before this layer). */
export function boundedInteractionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length < 1) return null;
  if (Buffer.byteLength(value, 'utf8') > MAX_NDJSON_LINE_BYTES) return null;
  return value;
}

function providerInteractionId(value: unknown): string {
  const id = boundedInteractionId(value);
  if (!id) fail('interaction_id is not a bounded identifier');
  return id;
}

function generation(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    fail(`${field} must be a positive integer`);
  }
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') fail(`${field} must be text`);
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(cleaned);
  if (chars.length === 0) fail(`${field} is empty`);
  return chars.slice(0, TEXT).join('');
}

function turn(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) fail('turn must be a positive integer or null');
  return value;
}

function actor(value: unknown): InboxActor {
  if (value !== 'user' && value !== 'system') fail('actor must be user or system');
  return value;
}

function product(value: unknown): 'gian' | 'integration' {
  if (value !== 'gian' && value !== 'integration') fail('product must be gian or integration');
  return value;
}

function updateTarget(productName: 'gian' | 'integration', target: unknown): string {
  const id = ident(target, 'target_id');
  if (productName === 'gian' && id !== 'gian') fail('Gian update target_id must be gian');
  return id;
}

/** Runtime gate. Unknown kinds throw. Completion and failure do not become Inbox rows. */
export function parseInboxSignal(value: unknown): InboxSignal {
  const body = record(value);
  const kind = body.kind;
  if (typeof kind !== 'string') fail('kind is required');
  if (IGNORED.has(kind)) return { kind } as InboxSignal;
  if (kind === 'session.question' || kind === 'session.approval') {
    const base = {
      kind,
      interaction_id: providerInteractionId(body.interaction_id),
      session_id: ident(body.session_id, 'session_id'),
      turn: turn(body.turn),
      generation: generation(body.generation, 'generation'),
      title: text(body.title, 'title'),
      summary: text(body.summary, 'summary'),
    };
    if (kind === 'session.approval') {
      if (typeof body.category !== 'string' || !APPROVAL_CATEGORIES.has(body.category)) {
        fail('approval category is not allowed');
      }
      return { ...base, kind, category: body.category as InboxApprovalCategory };
    }
    return { ...base, kind };
  }
  if (kind === 'session.question.closed' || kind === 'session.approval.closed') {
    const outcome = body.outcome;
    if (typeof outcome !== 'string' || !USER_OUTCOMES.has(outcome)) fail('outcome is not allowed');
    if (kind === 'session.question.closed' && outcome === 'rejected') fail('a question cannot be rejected');
    const interaction_id = providerInteractionId(body.interaction_id);
    const session_id = ident(body.session_id, 'session_id');
    const closedGeneration = generation(body.generation, 'generation');
    const closedActor = actor(body.actor);
    if (kind === 'session.question.closed') {
      return {
        kind,
        interaction_id,
        session_id,
        generation: closedGeneration,
        outcome: outcome as Exclude<InboxTerminalOutcome, 'rejected'>,
        actor: closedActor,
      };
    }
    if (body.category === undefined) {
      return {
        kind,
        interaction_id,
        session_id,
        generation: closedGeneration,
        outcome: outcome as InboxTerminalOutcome,
        actor: closedActor,
      };
    }
    if (typeof body.category !== 'string' || !APPROVAL_CATEGORIES.has(body.category)) {
      fail('approval category is not allowed');
    }
    return {
      kind,
      interaction_id,
      session_id,
      generation: closedGeneration,
      outcome: outcome as InboxTerminalOutcome,
      actor: closedActor,
      category: body.category as InboxApprovalCategory,
    };
  }
  if (kind === 'system.repair') {
    if (typeof body.scope !== 'string' || !REPAIR_SCOPES.has(body.scope)) fail('repair scope is not allowed');
    return {
      kind,
      scope: body.scope as InboxRepairScope,
      subject_id: ident(body.subject_id, 'subject_id'),
      fault_generation: generation(body.fault_generation, 'fault_generation'),
      title: text(body.title, 'title'),
      summary: text(body.summary, 'summary'),
    };
  }
  if (kind === 'system.repair.closed') {
    if (typeof body.scope !== 'string' || !REPAIR_SCOPES.has(body.scope)) fail('repair scope is not allowed');
    const outcome = body.outcome;
    if (outcome !== 'resolved' && outcome !== 'cancelled' && outcome !== 'expired') fail('outcome is not allowed');
    return {
      kind,
      scope: body.scope as InboxRepairScope,
      subject_id: ident(body.subject_id, 'subject_id'),
      fault_generation: generation(body.fault_generation, 'fault_generation'),
      outcome,
      actor: actor(body.actor),
    };
  }
  if (kind === 'system.pairing') {
    return {
      kind,
      request_id: ident(body.request_id, 'request_id'),
      generation: generation(body.generation, 'generation'),
      title: text(body.title, 'title'),
      summary: text(body.summary, 'summary'),
    };
  }
  if (kind === 'system.pairing.closed') {
    const outcome = body.outcome;
    if (typeof outcome !== 'string' || !USER_OUTCOMES.has(outcome)) fail('outcome is not allowed');
    return {
      kind,
      request_id: ident(body.request_id, 'request_id'),
      generation: generation(body.generation, 'generation'),
      outcome: outcome as InboxTerminalOutcome,
      actor: actor(body.actor),
    };
  }
  if (kind === 'product.update') {
    if (typeof body.phase !== 'string' || !PHASES.has(body.phase)) fail('update phase is not allowed');
    const name = product(body.product);
    return {
      kind,
      product: name,
      target_id: updateTarget(name, body.target_id),
      version: ident(body.version, 'version'),
      channel: ident(body.channel, 'channel'),
      epoch: generation(body.epoch, 'epoch'),
      phase: body.phase as InboxUpdatePhase,
      title: text(body.title, 'title'),
      summary: text(body.summary, 'summary'),
    };
  }
  if (kind === 'product.update.closed') {
    const name = product(body.product);
    const outcome = body.outcome;
    if (outcome !== 'resolved' && outcome !== 'cancelled' && outcome !== 'expired') fail('outcome is not allowed');
    return {
      kind,
      product: name,
      target_id: updateTarget(name, body.target_id),
      version: ident(body.version, 'version'),
      channel: ident(body.channel, 'channel'),
      generation: generation(body.generation, 'generation'),
      epoch: generation(body.epoch, 'epoch'),
      outcome,
      actor: actor(body.actor),
    };
  }
  fail(`kind is not an inbox source: ${kind}`);
}

export function isIgnoredInboxSignal(signal: InboxSignal): boolean {
  return IGNORED.has(signal.kind);
}
