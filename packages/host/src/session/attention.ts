import { createHash } from 'node:crypto';
import { stripGianActionBlocks } from '@gian/shared';
import type {
  ApprovalRequestedData,
  AttentionKind,
  AttentionMessage,
  ChatEvent,
  SessionErrorData,
} from '@gian/shared';
import type { WsBroadcaster } from '../web/ws-broadcast.js';

export const ATTENTION_TITLE_MAX_BYTES = 96;
export const ATTENTION_BODY_MAX_BYTES = 180;
const ATTENTION_SOURCE_SCAN_CHARS = 4_096;
const ATTENTION_DEDUPE_LIMIT = 1_024;

function truncateUtf8(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.byteLength <= maxBytes) return text;
  const suffix = '…';
  let end = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  // `end` is the first excluded byte. If it lands in the middle of a code
  // point, move back to that code point's leading byte and exclude it whole.
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return `${encoded.subarray(0, end).toString('utf8').trimEnd()}${suffix}`;
}

function redactNotificationPaths(text: string): string {
  return text
    .replace(/\bfile:\/\/\/[^\s,;)'"}]+/giu, '[path]')
    .replace(/(^|[\s('"=:])~\/[^\s,;)'"}]+/gu, '$1[path]')
    .replace(/(^|[\s('"=:])\/(?!\/)[^\s,;)'"}]+(?:\/[^\s,;)'"}]+)+/gu, '$1[path]')
    .replace(/\b[A-Za-z]:\\(?:[^\\\s,;)'"}]+\\)+[^\\\s,;)'"}]+/gu, '[path]');
}

/** Build the intentionally small, presentation-only notification envelope. */
export function attentionMessageForEvent(event: ChatEvent): AttentionMessage | null {
  const display = event.display;
  if (!display) return null;

  let kind: AttentionKind;
  let title: string;
  let fallbackBody: string;

  switch (display.type) {
    case 'state.turn-completed': {
      // Gian synthesizes this display boundary to fold failed and explicitly
      // stopped turns in the transcript. Those are not successful background
      // completions: the failure already has its own error attention, while a
      // user-initiated stop should stay quiet.
      if (event.data.status === 'error' || event.data.status === 'stopped') return null;
      kind = 'turn-completed';
      title = 'Turn completed';
      fallbackBody = `The agent finished turn ${event.turn}.`;
      break;
    }
    case 'interaction.approval': {
      const data = display.data as ApprovalRequestedData;
      kind = 'approval';
      title = data.category === 'exit_plan_mode' ? 'Plan ready for review' : 'Approval required';
      fallbackBody = data.category === 'command'
        ? 'The agent needs permission to run a command.'
        : data.category === 'network'
          ? 'The agent needs network access.'
          : data.category === 'file_write_outside_ws'
            ? 'The agent needs permission to write outside the workspace.'
            : data.category === 'exit_plan_mode'
              ? 'The agent has a plan ready for your decision.'
              : 'The agent needs your approval.';
      break;
    }
    case 'interaction.question': {
      kind = 'question';
      title = 'Question needs your input';
      fallbackBody = 'The agent is waiting for your answer.';
      break;
    }
    case 'state.error': {
      const data = display.data as SessionErrorData;
      kind = 'error';
      title = 'Agent stopped with an error';
      fallbackBody = data.retryable
        ? 'Open Gian to review the error and retry.'
        : 'Open Gian to review the error.';
      break;
    }
    default:
      return null;
  }

  const clean = (value: string, fallback: string, maxBytes: number): string => {
    let safe = value.slice(0, ATTENTION_SOURCE_SCAN_CHARS);
    safe = stripGianActionBlocks(safe)
      // Provider summaries and errors sometimes quote commands as Markdown.
      // Keep the notification useful without carrying those executable bits.
      .replace(/```[\s\S]*?(?:```|$)/gu, ' [details hidden] ')
      .replace(/`[^`\n]+`/gu, '[details hidden]');
    safe = redactNotificationPaths(safe)
      .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    return truncateUtf8(safe || fallback, maxBytes);
  };

  return {
    type: 'attention',
    id: `gian:attention:${createHash('sha256')
      .update(JSON.stringify([event.session_id, event.turn, kind, event.call_id]))
      .digest('base64url')}`,
    session_id: event.session_id,
    turn: event.turn,
    kind,
    timestamp: event.ts,
    title: clean(title, 'Gian needs your attention', ATTENTION_TITLE_MAX_BYTES),
    // 0.4.3 has no explicit notification-preview opt-in. Do not attempt to
    // infer whether provider prose contains a secret: keep every OS-facing
    // body generic and leave all display/raw detail in the transcript.
    body: clean(fallbackBody, fallbackBody, ATTENTION_BODY_MAX_BYTES),
    provider: event.provider,
  };
}

/**
 * Process-wide attention projection and bounded de-duplication. The Host
 * shares one instance across proxy events, protocol replay and JSONL Live
 * Sync so one persisted event cannot produce multiple native notifications.
 */
export class AttentionDispatcher {
  private recentIds = new Set<string>();

  constructor(private broadcaster: WsBroadcaster) {}

  claim(event: ChatEvent): AttentionMessage | null {
    const message = attentionMessageForEvent(event);
    if (!message || this.recentIds.has(message.id)) return null;
    this.recentIds.add(message.id);
    if (this.recentIds.size > ATTENTION_DEDUPE_LIMIT) {
      const oldest = this.recentIds.values().next().value as string | undefined;
      if (oldest !== undefined) this.recentIds.delete(oldest);
    }
    return message;
  }

  broadcast(event: ChatEvent): AttentionMessage | null {
    const message = this.claim(event);
    if (message) this.broadcaster.broadcast(message);
    return message;
  }
}
