/**
 * Replay projection: Kimi persisted messages → gian replay events.
 *
 * Identity rules (parity with the live stream):
 * - `sourceTurnId` = the native prompt_id (messages carry it; live turns are
 *   anchored on the same id from POST /prompts).
 * - Terminal eventIds come from terminalEventIdFor(nativeSessionId,
 *   sourceTurnId, method) — the same function the live projector uses for
 *   turn.completed / turn.failed.
 * - Content ids use `assistant:<prompt_id>` / `thinking:<prompt_id>`, matching
 *   the live delta contentIds.
 * - Activities are keyed by tool_call_id, matching live tool frames.
 *
 * Replay has NO usage events: Kimi's message store carries no per-message
 * token facts (session usage lives in the session snapshot only).
 */

import { createHash } from 'node:crypto';

import type { KimiContentPart, KimiMessage } from './types.js';

export type ReplayEvent = {
  method: string;
  eventId: string;
  sessionId: string;
  replayStreamId: string;
  sequence: number;
  sourceTurnId: string;
  emittedAt: string;
  data: Record<string, unknown>;
};

function sha16(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

export function terminalEventIdFor(
  nativeSessionId: string,
  sourceTurnId: string,
  method: 'turn.completed' | 'turn.failed',
): string {
  return `evt-${sha16([nativeSessionId, sourceTurnId, method])}`;
}

function inputItemsOf(message: KimiMessage): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  for (const part of message.content) {
    if (part.type === 'text' && part.text !== '') {
      items.push({ type: 'text', text: part.text });
    } else if (part.type === 'image' && part.source.kind === 'path') {
      items.push({ type: 'localImage', path: part.source.path, ...(part.name ? { name: part.name } : {}) });
    } else if (part.type === 'file' && typeof part.path === 'string') {
      items.push({
        type: 'localFile',
        path: part.path,
        ...(part.name ? { name: part.name } : {}),
        ...(part.media_type ? { mime: part.media_type } : {}),
      });
    }
  }
  return items;
}

function textOfParts(parts: KimiContentPart[], type: 'text' | 'thinking'): string {
  let out = '';
  for (const part of parts) {
    if (type === 'text' && part.type === 'text') out += part.text;
    if (type === 'thinking' && part.type === 'thinking') out += part.thinking;
  }
  return out;
}

function bounded(value: unknown): unknown {
  try {
    const json = JSON.stringify(value ?? null);
    if (json.length <= 64 * 1024) return value;
    return { truncated: true, originalBytes: json.length, preview: json.slice(0, 2_000) };
  } catch {
    return String(value);
  }
}

interface ReplayTurn {
  sourceTurnId: string;
  user: KimiMessage | null;
  assistants: KimiMessage[];
  anchorTime: string;
}

/** Group messages into turns keyed by prompt_id (fallback: the user message
 *  id; orphans attach to the previous turn or open their own). */
export function groupReplayTurns(messages: KimiMessage[]): ReplayTurn[] {
  const turns: ReplayTurn[] = [];
  const buckets = new Map<string, ReplayTurn>();
  for (const message of messages) {
    const key = typeof message.prompt_id === 'string' && message.prompt_id !== ''
      ? message.prompt_id
      : null;
    if (message.role === 'user') {
      const turn: ReplayTurn = {
        sourceTurnId: key ?? message.id,
        user: message,
        assistants: [],
        anchorTime: message.created_at ?? new Date(0).toISOString(),
      };
      turns.push(turn);
      if (key !== null) buckets.set(key, turn);
      continue;
    }
    const host = key !== null ? buckets.get(key) : turns.at(-1);
    if (host !== undefined) {
      host.assistants.push(message);
      if (key !== null) buckets.set(key, host);
    } else {
      const turn: ReplayTurn = {
        sourceTurnId: key ?? message.id,
        user: null,
        assistants: [message],
        anchorTime: message.created_at ?? new Date(0).toISOString(),
      };
      turns.push(turn);
      if (key !== null) buckets.set(key, turn);
    }
  }
  return turns;
}

export function buildReplayEvents(context: {
  sessionId: string;
  nativeSessionId: string;
  replayStreamId: string;
  messages: KimiMessage[];
}): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  let sequence = 0;
  const push = (
    turn: ReplayTurn,
    method: string,
    eventId: string,
    data: Record<string, unknown>,
    emittedAt?: string,
  ): void => {
    events.push({
      method,
      eventId,
      sessionId: context.sessionId,
      replayStreamId: context.replayStreamId,
      sequence: ++sequence,
      sourceTurnId: turn.sourceTurnId,
      emittedAt: emittedAt ?? turn.anchorTime,
      data,
    });
  };

  for (const turn of groupReplayTurns(context.messages)) {
    const all = [...(turn.user !== null ? [turn.user] : []), ...turn.assistants];
    const lastTime = all.at(-1)?.created_at;

    push(
      turn,
      'turn.started',
      `evt-${sha16([context.nativeSessionId, turn.sourceTurnId, 'turn.started'])}`,
      {},
      turn.anchorTime,
    );

    for (const message of all) {
      if (message.role === 'user') {
        const items = inputItemsOf(message);
        if (items.length > 0) {
          push(
            turn,
            'input.recorded',
            `evt-${sha16([context.nativeSessionId, message.id, 'input.recorded'])}`,
            { input: items },
            message.created_at,
          );
        }
        continue;
      }
      // Assistant / tool / system messages: content, reasoning, tool calls.
      const text = textOfParts(message.content, 'text');
      if (text !== '') {
        push(
          turn,
          'content.completed',
          `evt-${sha16([context.nativeSessionId, message.id, 'content.text'])}`,
          { contentId: `assistant:${turn.sourceTurnId}`, kind: 'text', format: 'markdown', content: text },
          message.created_at,
        );
      }
      const thinking = textOfParts(message.content, 'thinking');
      if (thinking !== '') {
        push(
          turn,
          'content.completed',
          `evt-${sha16([context.nativeSessionId, message.id, 'content.thinking'])}`,
          { contentId: `thinking:${turn.sourceTurnId}`, kind: 'reasoning', content: thinking },
          message.created_at,
        );
      }
      for (const part of message.content) {
        if (part.type !== 'tool_use') continue;
        const result = all
          .flatMap((entry) => entry.content)
          .find((candidate) => candidate.type === 'tool_result' && candidate.tool_call_id === part.tool_call_id);
        const isError = result?.type === 'tool_result' && result.is_error === true;
        push(
          turn,
          'activity.updated',
          `evt-${sha16([context.nativeSessionId, part.tool_call_id, 'activity:terminal'])}`,
          {
            activityId: part.tool_call_id,
            kind: `tool:${part.tool_name}`,
            title: part.tool_name,
            status: result === undefined ? 'failed' : isError ? 'failed' : 'succeeded',
            presentation: {
              type: 'tool',
              data: {
                name: part.tool_name,
                ...(part.input !== undefined ? { input: bounded(part.input) } : {}),
                ...(result !== undefined
                  ? { output: bounded((result as { output?: unknown }).output) }
                  : {}),
              },
            },
            ...(result === undefined ? { details: { note: 'no tool result was recorded for this call' } } : {}),
          },
          message.created_at,
        );
      }
    }

    push(
      turn,
      'turn.completed',
      terminalEventIdFor(context.nativeSessionId, turn.sourceTurnId, 'turn.completed'),
      { stopReason: 'completed' },
      lastTime,
    );
  }

  return events;
}
