/**
 * Execution Trace contract — the read model projected from canonical
 * gian.proxy/2.0 execution evidence.
 *
 * The Trace is a best-effort Core projection over the durable canonical
 * event evidence recorded per session. Every item declares where its content
 * came from (`evidence`) and which protocol events contributed to it
 * (`sourceEventIds`); the snapshot declares whether the evidence was complete
 * enough to reconstruct the full session (`partial`).
 *
 * Consumers must treat `detail` and `summary` as bounded display surfaces,
 * never as the authoritative event payload — the canonical evidence (the
 * `events` rows plus `trace_events` rows) remains the source of truth.
 */

/** JSON-safe value used for structured item details. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Where an item's content came from. */
export type TraceEvidence = 'native' | 'derived' | 'synthetic';

/** Lifecycle status of a turn, tool, or content stream. */
export type TraceStatus = 'running' | 'succeeded' | 'failed' | 'interrupted';

/** Temporal shape of an item in the execution model. */
export type TraceItemShape = 'span' | 'event';

/** The closed set of item kinds the Trace projection can emit. */
export type TraceItemKind =
  | 'turn'
  | 'input'
  | 'assistant'
  | 'reasoning'
  | 'plan'
  | 'step'
  | 'request'
  | 'tool'
  | 'agent'
  | 'notice';

/**
 * One projected execution item.
 *
 * - `id` is a stable, deterministic identifier derived from the contributing
 *   protocol identities (turn id, toolCallId, contentId, …).
 * - `turnId` is the provider-scoped turn id carried by the evidence.
 * - `at` / `endAt` are the provider-emitted event timestamps (ISO-8601).
 *   `durationMs` is present only when both ends are known — never fabricated.
 * - `evidence` marks the item as a direct projection of one native event
 *   (`native`), a reliable aggregation of several events (`derived`), or an
 *   item generated at the Core boundary (`synthetic`).
 */
export interface TraceItem {
  id: string;
  turnId: string;
  kind: TraceItemKind;
  /** A lifecycle with a start/end (`span`) or a point-in-time fact (`event`). */
  shape: TraceItemShape;
  title: string;
  summary?: string;
  status?: TraceStatus;
  at: string;
  endAt?: string;
  durationMs?: number;
  evidence: TraceEvidence;
  /** Stable Trace item id of the containing turn or step. */
  parentId?: string;
  /** Provider-scoped identity the item is bound to (toolCallId, contentId, …). */
  correlationId?: string;
  /** eventIds of the canonical evidence rows this item was projected from. */
  sourceEventIds: string[];
  detail?: JsonValue;
}

/**
 * Point-in-time read model for one session.
 *
 * `partial` is true whenever the available evidence cannot reconstruct the
 * session completely (missing turn boundaries, orphan tool completions,
 * unattachable events, unparseable timestamps, or a session that predates
 * trace evidence). A `partial` snapshot is still valid for display.
 */
export interface TraceSnapshot {
  sessionId: string;
  generatedAt: string;
  partial: boolean;
  items: TraceItem[];
}
