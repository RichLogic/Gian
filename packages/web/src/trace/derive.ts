/**
 * Transcript → TraceSnapshot projection (Trace frontend MVP, 2026-08-15).
 *
 * The Host does not publish trace snapshots yet, so the Trace page derives
 * one from the transcript items the web already holds. Every projected item
 * is stamped `evidence: 'derived'` — the UI never presents these as native
 * provider traces. When the backend contract lands this file is the single
 * seam to delete: the frozen types, model, and views stay unchanged.
 *
 * Mapping notes:
 * - `turn-start`/`turn-end` markers become one `kind: 'turn'` item per turn
 *   (carrying the turn's time bounds); a turn number seen only on content
 *   items still gets a synthesized turn track so grouping always has an
 *   anchor. This is NOT a placeholder capability track — turns always exist.
 * - tool/command/file-read/file-search/web-search/diff all project to
 *   `kind: 'tool'` (they are the transcript's tool-projection kinds) keyed by
 *   the provider call id as `correlationId`, so a later native feed upserts
 *   onto the same rows.
 * - approvals project to `kind: 'notice'` (the contract has no interaction
 *   kind); reasoning variant and plan absence pass through untouched — no
 *   reasoning/plan items are invented when the provider never emitted any.
 */

import type { TranscriptItem } from '../types.js';
import { transcriptItemIdentity } from '../transcript/identity.js';
import type { TraceItem, TraceSnapshot, TraceStatus } from './types.js';

export const DERIVED_EVIDENCE = 'derived' as const;

function iso(ts: number): string {
  return new Date(ts).toISOString();
}

function firstLine(text: string, max = 80): string {
  const line = text.split('\n').find(l => l.trim().length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function turnIdOf(turn: number): string {
  return `turn:${turn}`;
}

function projectItem(item: TranscriptItem): TraceItem | null {
  const base = {
    turnId: turnIdOf(item.turn),
    at: iso(item.ts),
    evidence: DERIVED_EVIDENCE,
    sourceEventIds: [transcriptItemIdentity(item)],
  };
  switch (item.kind) {
    case 'user':
      return {
        ...base,
        id: transcriptItemIdentity(item),
        kind: 'input',
        title: firstLine(item.text) || '(attachment)',
        detail: { text: item.text },
      };
    case 'assistant':
      return {
        ...base,
        id: transcriptItemIdentity(item),
        kind: 'assistant',
        title: firstLine(item.text),
        detail: { text: item.text },
      };
    case 'reasoning':
      return {
        ...base,
        id: transcriptItemIdentity(item),
        kind: 'reasoning',
        title: firstLine(item.text),
        summary: item.variant,
        detail: { variant: item.variant, text: item.text },
      };
    case 'tool':
      return {
        ...base,
        id: transcriptItemIdentity(item),
        kind: 'tool',
        title: item.name,
        summary: item.summary || undefined,
        status: item.status === 'success' ? 'succeeded'
          : item.status === 'error' ? 'failed'
          : 'running',
        correlationId: item.id,
        detail: { output: item.output ?? null },
      };
    case 'command':
      return {
        ...base,
        id: transcriptItemIdentity(item),
        kind: 'tool',
        title: item.command,
        summary: item.cwd,
        status: item.status === 'success' ? 'succeeded'
          : item.status === 'error' ? 'failed'
          : 'running',
        correlationId: item.id,
        detail: { stdout: item.stdout, stderr: item.stderr ?? null, exitCode: item.exitCode ?? null },
      };
    case 'file-read':
      return {
        ...base,
        id: transcriptItemIdentity(item),
        kind: 'tool',
        title: item.path,
        summary: item.startLine !== undefined
          ? `:${item.startLine}${item.endLine !== undefined ? `–${item.endLine}` : ''}`
          : undefined,
        status: 'succeeded',
        correlationId: item.id,
      };
    case 'file-search':
      return {
        ...base,
        id: transcriptItemIdentity(item),
        kind: 'tool',
        title: item.pattern,
        summary: item.searchKind,
        status: 'succeeded',
        correlationId: item.id,
        detail: { matches: item.matches ?? null, matchCount: item.matchCount ?? null },
      };
    case 'web-search':
      return {
        ...base,
        id: transcriptItemIdentity(item),
        kind: 'tool',
        title: item.query,
        status: 'succeeded',
        correlationId: item.id,
        detail: { resultCount: item.resultCount ?? null },
      };
    case 'diff':
      return {
        ...base,
        id: transcriptItemIdentity(item),
        kind: 'tool',
        title: item.files.length === 1
          ? `Edit ${item.files[0]!.path}`
          : `Edit ${item.files.length} files`,
        status: 'succeeded',
        correlationId: item.id,
        detail: {
          files: item.files.map(f => ({ path: f.path, add: f.add, del: f.del })),
        },
      };
    case 'agent-spawn':
      return {
        ...base,
        id: transcriptItemIdentity(item),
        kind: 'agent',
        title: item.description,
        status: item.status === 'done' ? 'succeeded'
          : item.status === 'error' ? 'failed'
          : 'running',
        at: iso(item.startedAt),
        endAt: item.completedAt !== undefined ? iso(item.completedAt) : undefined,
        correlationId: item.id,
        detail: {
          provider: item.provider,
          agentType: item.agentType ?? null,
          model: item.model ?? null,
          output: item.output ?? null,
        },
      };
    case 'approval':
      return {
        ...base,
        id: transcriptItemIdentity(item),
        kind: 'notice',
        title: item.title,
        summary: item.cmd,
        status: item.status === 'pending' ? 'running'
          : item.status === 'declined' ? 'failed'
          : 'succeeded',
        detail: { reason: item.reason, risk: item.risk, status: item.status },
      };
    case 'auto-notice':
      return {
        ...base,
        id: transcriptItemIdentity(item),
        kind: 'notice',
        title: item.title || item.code || item.variant,
        summary: item.message,
        status: item.severity === 'error' ? 'failed' : undefined,
        detail: { variant: item.variant, code: item.code ?? null },
      };
    case 'error':
      return {
        ...base,
        id: transcriptItemIdentity(item),
        kind: 'notice',
        title: firstLine(item.text),
        status: 'failed',
        detail: { text: item.text },
      };
    case 'status':
      return {
        ...base,
        id: transcriptItemIdentity(item),
        kind: 'notice',
        title: firstLine(item.text),
        detail: { text: item.text },
      };
    case 'compaction':
      return {
        ...base,
        id: transcriptItemIdentity(item),
        kind: 'notice',
        title: 'Context compacted',
        detail: { beforeTokens: item.beforeTokens ?? null, afterTokens: item.afterTokens ?? null },
      };
    case 'turn-start':
    case 'turn-end':
      return null; // folded into the synthesized turn track below
  }
}

export interface DeriveTraceOptions {
  /** True while the session is still streaming or its history is not fully
   *  hydrated — the snapshot must then present itself as partial. */
  partial: boolean;
  /** Stamp for `generatedAt`; injected so the projection stays pure. */
  generatedAt: string;
}

/**
 * Project transcript items into a trace snapshot. Turn tracks are
 * synthesized from `turn-start`/`turn-end` markers (or inferred from the
 * turn numbers content items carry); their status is explicit so the model
 * layer never guesses "running" for a finished turn:
 *   no turn-end            → running
 *   turn-end + error child → failed
 *   turn-end               → succeeded
 */
export function deriveTraceSnapshot(
  items: TranscriptItem[],
  sessionId: string,
  options: DeriveTraceOptions,
): TraceSnapshot {
  const turnStart = new Map<number, number>();
  const turnEnd = new Map<number, number>();
  const turnFailed = new Set<number>();
  const projected: TraceItem[] = [];

  for (const item of items) {
    if (item.kind === 'turn-start') {
      if (!turnStart.has(item.turn)) turnStart.set(item.turn, item.ts);
      continue;
    }
    if (item.kind === 'turn-end') {
      if (!turnEnd.has(item.turn)) turnEnd.set(item.turn, item.ts);
      continue;
    }
    if (item.kind === 'error') turnFailed.add(item.turn);
    const traceItem = projectItem(item);
    if (traceItem) projected.push(traceItem);
  }

  const turnNumbers = new Set<number>([
    ...turnStart.keys(),
    ...turnEnd.keys(),
    ...projected.map(item => Number(item.turnId.slice('turn:'.length))),
  ]);
  const turnItems: TraceItem[] = [...turnNumbers]
    .filter(turn => Number.isFinite(turn))
    .map(turn => {
      const start = turnStart.get(turn);
      const end = turnEnd.get(turn);
      const status: TraceStatus = end === undefined
        ? 'running'
        : turnFailed.has(turn) ? 'failed' : 'succeeded';
      const childAts = projected
        .filter(item => item.turnId === turnIdOf(turn))
        .map(item => Date.parse(item.at));
      const at = start ?? (childAts.length > 0 ? Math.min(...childAts) : 0);
      return {
        id: turnIdOf(turn),
        turnId: turnIdOf(turn),
        kind: 'turn' as const,
        title: `Turn ${turn}`,
        status,
        at: iso(at),
        endAt: end !== undefined ? iso(end) : undefined,
        evidence: DERIVED_EVIDENCE,
        sourceEventIds: [
          ...(start !== undefined ? [`${turn}:turn-start`] : []),
          ...(end !== undefined ? [`${turn}:turn-end`] : []),
        ],
      };
    });

  return {
    sessionId,
    generatedAt: options.generatedAt,
    partial: options.partial,
    items: [...turnItems, ...projected],
  };
}
