/**
 * The host-facing seam the bridge core programs against. DSH-WP0 probes froze
 * this minimal surface from the actual `@deepseek-ai/dsh@latest` runtime:
 *
 * - `ctx.agents.create / resume / get / roots / list` (dsh-agent AgentRegistry)
 * - `Agent.send / followup / steer / inject / cancel / whenIdle`
 * - `session/event`, `agent/status`, `agent/error`, `agent/inbox/*`
 * - `ctx.userQuestions.registerProvider / ask`
 * - `ctx.approval` watermark listeners (`approval/request`) and outcome set
 * - `ctx.sessionPersistence.list / inspect / prepare / readFrom` (no delete,
 *   no cross-process owner field, so native list/delete/attach stay absent)
 *
 * The fake implementation in `fake-host.ts` replays the exact same shapes for
 * deterministic contract tests with zero model calls.
 */

import type { BridgeJsonValue } from './schema.js';

export interface BridgeSessionCreateParams {
  sessionId: string;
  cwd: string;
  roots: string[];
  config: Record<string, BridgeJsonValue>;
  /** Omitted for new sessions; only accepted against a resumed native id. */
  nativeSessionId?: string;
  restartNewStream?: boolean;
}

export interface BridgeTurnInputItem {
  type: 'text' | 'localFile' | 'localImage' | 'skill';
  text?: string;
  path?: string;
  name?: string;
  mime?: string;
  size?: number;
}

export interface BridgeTurnStartParams {
  sessionId: string;
  turnId: string;
  input: BridgeTurnInputItem[];
  config: Record<string, BridgeJsonValue>;
}

export interface BridgeInteractionRequest {
  interactionId: string;
  kind: 'approval' | 'question' | 'choice' | 'confirmation' | 'plan_review';
  title?: string;
  description?: string;
  inputs: Array<{
    id: string;
    type: 'text' | 'multiline_text' | 'single_select' | 'multi_select' | 'boolean';
    label: string;
    required: boolean;
    description?: string;
    choices?: Array<{ value: string; displayName: string }>;
    sensitive?: boolean;
  }>;
  actions: Array<{ id: string; label: string; style: 'primary' | 'secondary' | 'danger' }>;
  context?: Record<string, BridgeJsonValue>;
  /** Native correlation field; the proxy derives the Gian turnId separately. */
  sessionId: string;
  turn?: number;
  step?: number;
}

export interface BridgeHostEvent {
  /** Bridge notification method name. */
  method: string;
  params: Record<string, unknown>;
}

export interface BridgeInteractionRespondParams {
  sessionId: string;
  interactionId: string;
  actionId?: string;
  values: Record<string, unknown>;
}

export interface BridgeHost {
  readonly kind: 'fake' | 'cordis';
  readonly bridgeVersion: string;
  readonly dshVersion: string;
  readonly sessionFormatVersion: number;

  /** Set by the server once it is routing; the host flushes queued early events. */
  attachSink(sink: (event: BridgeHostEvent) => void): void;

  initialize(params: { protocol: { versions: string[] } }): Promise<Record<string, unknown>>;
  catalogList(): Promise<Record<string, unknown>>;
  catalogResolve(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  sessionCreate(params: BridgeSessionCreateParams): Promise<Record<string, unknown>>;
  sessionResume(params: { sessionId: string; nativeSessionId: string }): Promise<Record<string, unknown>>;
  sessionGet(params: { sessionId: string }): Promise<Record<string, unknown>>;
  sessionClose(params: { sessionId: string }): Promise<Record<string, unknown>>;
  sessionNativeList(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  sessionRename(params: { sessionId: string; name: string }): Promise<Record<string, unknown>>;
  sessionEventsRead(params: {
    sessionId: string;
    cursor?: string | null;
    limit?: number;
  }): Promise<Record<string, unknown>>;
  turnStart(params: BridgeTurnStartParams): Promise<Record<string, unknown>>;
  turnSteer(params: { sessionId: string; turnId?: string; input: unknown[] }): Promise<Record<string, unknown>>;
  turnInterrupt(params: { sessionId: string; turnId?: string }): Promise<Record<string, unknown>>;
  interactionRespond(params: BridgeInteractionRespondParams): Promise<Record<string, unknown>>;
  shutdown(): Promise<Record<string, unknown>>;
}
