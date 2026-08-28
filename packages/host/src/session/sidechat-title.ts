import { sanitizeTitle, truncateFallbackTitle } from './auto-title.js';
import type { SidechatRecord, SidechatStoredUserInput } from './sidechat-store.js';

const GENERIC_AGENT_TITLES = new Set([
  'done',
  'fixed',
  'complete',
  'completed',
  'sure',
  '好的',
  '可以',
  '完成',
  '已完成',
  '修复完成',
]);

function cleanMarkdownLine(raw: string): string {
  return raw
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*(?:>|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function meaningfulAgentLine(content: string): string | null {
  const lines: Array<{ text: string; heading: boolean }> = [];
  let fenced = false;
  for (const raw of content.split('\n')) {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !raw.trim()) continue;
    const text = cleanMarkdownLine(raw);
    if (text) lines.push({ text, heading: /^\s{0,3}#{1,6}\s+/.test(raw) });
  }
  const candidate = lines.find(line => line.heading)?.text ?? lines[0]?.text;
  const genericKey = candidate?.toLocaleLowerCase().replace(/[.!?。！？]+$/u, '').trim();
  if (!candidate || (genericKey && GENERIC_AGENT_TITLES.has(genericKey))) return null;
  return candidate;
}

function eventRecord(event: unknown): Record<string, unknown> | null {
  return event && typeof event === 'object' ? event as Record<string, unknown> : null;
}

function completedAgentText(events: unknown[], turnId: string): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = eventRecord(events[index]);
    if (event?.method !== 'content.completed') continue;
    const params = eventRecord(event.params);
    if (params?.turnId !== turnId) continue;
    const data = eventRecord(params.data);
    if (data?.kind !== 'text' || typeof data.content !== 'string' || !data.content.trim()) continue;
    return data.content;
  }
  return null;
}

function inputText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = inputText(item);
      if (text) return text;
    }
    return null;
  }
  const item = eventRecord(value);
  return item?.type === 'text' && typeof item.text === 'string' && item.text.trim()
    ? item.text
    : null;
}

function firstUserText(inputs: SidechatStoredUserInput[]): string | null {
  for (const entry of inputs) {
    const text = inputText(entry.input);
    if (text) return text;
  }
  return null;
}

function titleFromText(text: string): string | null {
  const title = sanitizeTitle(truncateFallbackTitle(text));
  return title || null;
}

/** Derive once from the completed Agent response, falling back to user input. */
export function deriveSidechatAgentTitle(record: SidechatRecord, turnId: string): string | null {
  const agentText = completedAgentText(record.events, turnId);
  const agentLine = agentText ? meaningfulAgentLine(agentText) : null;
  return agentLine ? titleFromText(agentLine) : titleFromText(firstUserText(record.userInputs) ?? '');
}
