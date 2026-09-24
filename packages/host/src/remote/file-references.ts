import { isAbsolute, resolve } from 'node:path';
import type { EventEnvelope } from '@gian/shared';

export function conversationReferencesAttachment(events: Iterable<EventEnvelope>, sessionId: string, filename: string): boolean {
  for (const event of events) {
    if (event.session_id !== sessionId || !Array.isArray(event.data.attachments)) continue;
    for (const attachment of event.data.attachments) {
      if (!attachment || typeof attachment !== 'object' || typeof attachment.url !== 'string') continue;
      const prefix = `/api/sessions/${sessionId}/attachments/`;
      if (!attachment.url.startsWith(prefix)) continue;
      try { if (decodeURIComponent(attachment.url.slice(prefix.length)) === filename) return true; } catch { /* malformed URL */ }
    }
  }
  return false;
}

/** References come from persisted conversation content, never a claim in a
 * preview request. Exact token boundaries prevent prefix/parent widening. */
export function conversationReferencesFile(events: Iterable<EventEnvelope>, filename: string): boolean {
  if (!isAbsolute(filename)) return false;
  const normalized = resolve(filename);
  for (const event of events) {
    const data = event.data;
    const display = event.display?.data as unknown as Record<string, unknown> | undefined;
    const texts = [data.text, display?.text, display?.subject, display?.stdout, display?.stdoutDelta, display?.description];
    for (const text of texts) {
      if (typeof text !== 'string') continue;
      if (containsReference(text, normalized)) return true;
      try { if (containsReference(decodeURIComponent(text), normalized)) return true; } catch { /* literal percent text */ }
    }
    const contexts = Array.isArray(data.context_items) ? data.context_items : [];
    for (const value of contexts) {
      if (!value || typeof value !== 'object') continue;
      const item = value as Record<string, unknown>;
      if (item.type === 'file' && typeof item.path === 'string' && isAbsolute(item.path) && resolve(item.path) === normalized) return true;
    }
    const files = Array.isArray(display?.files) ? display.files : [];
    for (const value of files) {
      if (!value || typeof value !== 'object') continue;
      const item = value as Record<string, unknown>;
      if (typeof item.path === 'string' && isAbsolute(item.path) && resolve(item.path) === normalized) return true;
    }
  }
  return false;
}

function containsReference(text: string, filename: string): boolean {
  let at = text.indexOf(filename);
  while (at >= 0) {
    const before = at === 0 ? '' : text[at - 1]!;
    const rest = text.slice(at + filename.length);
    const starts = !before || /[\s`'"(<\[]/.test(before);
    const ends = !rest || /^[\s`'"\])>,;。；，]/.test(rest) || /^:\d+(?::\d+)?(?:$|[\s`'"\])>,;])/.test(rest)
      || /^\.(?:$|\s)/.test(rest);
    if (starts && ends) return true;
    at = text.indexOf(filename, at + filename.length);
  }
  return false;
}
