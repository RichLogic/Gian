import { redactRemoteConversationText } from '@gian/remote-protocol';
import type { ComposerDocument, InputItem, MessageContextItem, TranslationRecord } from '@gian/shared';
import type { Db } from '../storage/db.js';
import type { TranslationService } from './service.js';

export interface ControllerTranslationInput {
  send_id?: string;
  text: string;
  items?: InputItem[];
  context_items?: MessageContextItem[];
  composer_document?: ComposerDocument;
  translation_id?: string;
}

/** The request receipt stays local. Only prepared execution text crosses the wire. */
export function translatedRemoteInput(input: ControllerTranslationInput, record: TranslationRecord): ControllerTranslationInput {
  if ((input.items?.filter(item => item.type === 'text').length ?? 0) > 1
    || input.items?.some(item => item.type === 'skill')) {
    throw new Error('Translated remote sending requires one user text input.');
  }
  const instruction = `\n\nPlease respond in ${record.targetLanguage}. Keep code, identifiers, file paths and quoted source material unchanged.`;
  const text = record.text + instruction;
  const document = record.translatedDocument;
  return {
    text,
    ...(input.items ? { items: input.items.map(item => item.type === 'text' ? { ...item, text } : item) } : {}),
    ...(input.context_items ? { context_items: input.context_items } : {}),
    ...(document ? { composer_document: { version: 1, segments: [...document.segments, { type: 'text', text: instruction }] } as ComposerDocument } : {}),
  };
}

interface OriginRow {
  translation_id: string | null;
  input_json: string;
  params_json: string;
  result_json: string | null;
  method: string;
}

export interface LocalTranslationOrigin {
  sendId?: string;
  translation: TranslationRecord;
  contextItems?: MessageContextItem[];
  document?: ComposerDocument;
}

/** Never match by text alone: identical translations may belong to different sends. */
export function remoteTranslationOrigin(db: Db, service: TranslationService, localId: string,
  remote: { text: string; deliveryId?: string; queueId?: string }): LocalTranslationOrigin | undefined {
  if (!remote.deliveryId && !remote.queueId) return undefined;
  if (remote.deliveryId) {
    const count = db.prepare(`SELECT COUNT(DISTINCT json_extract(item_json, '$.item.id')) AS count
      FROM remote_execution_replica_events WHERE local_session_id = ? AND json_extract(item_json, '$.item.delivery_id') = ?`)
      .get(localId, remote.deliveryId) as { count: number };
    // Older peers used a turn-level delivery id for every steer. Never
    // misattribute a source-language message when that identity is ambiguous.
    if (count.count > 1) return undefined;
  }
  const origin = db.prepare(`SELECT * FROM remote_execution_send_requests WHERE local_session_id = ?
    AND method = 'session.send' AND json_extract(result_json, ?) = ? LIMIT 1`)
    .get(localId, remote.deliveryId ? '$.delivery_id' : '$.queue_id', remote.deliveryId ?? remote.queueId) as OriginRow | undefined;
  if (!origin) return undefined;
  const queueId = remote.queueId ?? (origin.result_json ? JSON.parse(origin.result_json).queue_id : undefined);
  const edit = queueId ? db.prepare(`SELECT * FROM remote_execution_send_requests WHERE local_session_id = ?
    AND method = 'queue.update' AND json_extract(params_json, '$.queue_id') = ? AND result_json IS NOT NULL
    ORDER BY rowid DESC LIMIT 1`).get(localId, queueId) as OriginRow | undefined : undefined;
  const row = edit ?? origin;
  if (!row.translation_id) return undefined;
  const record = service.get(row.translation_id);
  const params = JSON.parse(row.params_json) as { text?: string };
  if (!record || record.sessionId !== localId || record.purpose !== 'send' || typeof params.text !== 'string') return undefined;
  if (remote.text !== params.text && remote.text !== redactRemoteConversationText(params.text).slice(0, 16_000)) return undefined;
  const stored = JSON.parse(row.input_json) as { input?: ControllerTranslationInput };
  return {
    ...(stored.input?.send_id ? { sendId: stored.input.send_id } : {}),
    translation: { ...record, text: params.text },
    ...(edit ? {} : { contextItems: stored.input?.context_items, document: record.sourceDocument }),
  };
}
