import { z } from 'zod';

import {
  ATTENTION_KINDS,
  BUSINESS_CAPABILITY_IDS,
  COMMAND_STATUS_STATES,
  CONTENT_WINDOW_CHUNKS,
  DOWNLOAD_KINDS,
  INTERACTION_KINDS,
  MAX_ARRAY_ITEMS,
  MAX_ATTACHMENT_BYTES,
  MAX_CONTENT_CHUNK_PLAINTEXT_BYTES,
  MAX_FILE_PREVIEW_BYTES,
  MAX_HELLO_CAPABILITIES,
  MAX_QUEUE_ENTRIES,
  MAX_SESSION_PAGE_TURNS,
  MAX_SNAPSHOT_PARTS,
  MAX_SNAPSHOT_TOTAL_BYTES,
  MIN_SESSION_PAGE_TURNS,
  REMOTE_ERROR_CODES,
  REMOTE_MAJOR_VERSION,
  REMOTE_MAX_MINOR_VERSION,
  REMOTE_METHODS,
  REMOTE_MIN_MINOR_VERSION,
  REMOTE_PROTOCOL,
  SESSION_STATUSES,
  SNAPSHOT_REQUIRED_REASONS,
  WIRE_FEATURES,
} from './constants.js';
import { RemoteProtocolError } from './errors.js';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalJson,
  sha256Hex,
  utf8ByteLength,
} from './serialize.js';
import {
  boundedStringSchema,
  canonicalIdSchema,
  nameSchema,
  nonNegativeSafeIntegerSchema,
  parseClosed,
  positiveSafeIntegerSchema,
  remoteProtocolSchema,
  sha256HexSchema,
  unixMsSchema,
  uuidV7Schema,
  validateCommandIdentity,
  wireFeatureIdSchema,
} from './validation.js';

export const remoteMethodSchema = z.enum(REMOTE_METHODS);
export const remoteErrorCodeSchema = z.enum(REMOTE_ERROR_CODES);
export const wireFeatureSchema = z.enum(WIRE_FEATURES);

export const remoteCommandErrorSchema = z.strictObject({
  code: remoteErrorCodeSchema,
  message: boundedStringSchema,
});

const capabilityStateSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('supported') }),
  z.strictObject({ state: z.literal('unsupported'), reason: boundedStringSchema.optional() }),
  z.strictObject({ state: z.literal('offline'), reason: boundedStringSchema }),
  z.strictObject({ state: z.literal('denied'), reason: boundedStringSchema }),
  z.strictObject({ state: z.literal('version_mismatch'), reason: boundedStringSchema }),
]);

export const effectiveCapabilitiesSchema = z.strictObject({
  'catalog.read': capabilityStateSchema.optional(),
  'state.refresh': capabilityStateSchema.optional(),
  'task.read': capabilityStateSchema.optional(),
  'session.read': capabilityStateSchema.optional(),
  'session.create': capabilityStateSchema.optional(),
  'session.update': capabilityStateSchema.optional(),
  'session.send': capabilityStateSchema.optional(),
  'session.stop': capabilityStateSchema.optional(),
  'queue.read': capabilityStateSchema.optional(),
  'queue.add': capabilityStateSchema.optional(),
  'queue.update': capabilityStateSchema.optional(),
  'queue.remove': capabilityStateSchema.optional(),
  'queue.clear': capabilityStateSchema.optional(),
  'queue.send_now': capabilityStateSchema.optional(),
  'turn.steer': capabilityStateSchema.optional(),
  'interaction.read': capabilityStateSchema.optional(),
  'interaction.respond': capabilityStateSchema.optional(),
  'attachment.upload': capabilityStateSchema.optional(),
  'attachment.read': capabilityStateSchema.optional(),
  'file.read': capabilityStateSchema.optional(),
  'file.download': capabilityStateSchema.optional(),
});

export const remoteTaskSchema = z.strictObject({
  id: canonicalIdSchema,
  name: nameSchema,
  updated_at: boundedStringSchema,
  session_ids: z.array(canonicalIdSchema).max(MAX_ARRAY_ITEMS),
});

export const remoteAttachmentHandleSchema = z.strictObject({
  type: z.literal('attachment'),
  attachment_id: canonicalIdSchema,
});

export const remoteTextItemSchema = z.strictObject({
  type: z.literal('text'),
  text: boundedStringSchema,
});

export const remoteInputItemSchema = z.discriminatedUnion('type', [
  remoteTextItemSchema,
  remoteAttachmentHandleSchema,
]);

export const remoteContextItemSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('pasted_text'),
    text: boundedStringSchema,
  }),
  z.strictObject({
    type: z.literal('file_ref'),
    handle_id: canonicalIdSchema,
  }),
]);

export const remoteComposerNodeSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: boundedStringSchema }),
  z.strictObject({ type: z.literal('reference'), handle_id: canonicalIdSchema }),
]);

export const remoteComposerDocumentSchema = z.strictObject({
  type: z.literal('document'),
  nodes: z.array(remoteComposerNodeSchema).max(MAX_ARRAY_ITEMS),
});

export const remoteQueueEntrySchema = z.strictObject({
  id: canonicalIdSchema,
  session_id: canonicalIdSchema,
  text: boundedStringSchema,
  created_at: boundedStringSchema,
  items: z.array(remoteInputItemSchema).max(32).optional(),
  context_items: z.array(remoteContextItemSchema).max(32).optional(),
  composer_document: remoteComposerDocumentSchema.optional(),
  delivery_id: canonicalIdSchema.optional(),
});

export const remoteSessionSchema = z.strictObject({
  id: canonicalIdSchema,
  revision: boundedStringSchema,
  name: nameSchema.nullable(),
  task_id: canonicalIdSchema.nullable(),
  workspace_id: canonicalIdSchema,
  agent: z.strictObject({
    id: canonicalIdSchema,
    name: nameSchema,
    proxy: nameSchema,
  }),
  model: nameSchema.nullable().optional(),
  thinking: nameSchema.nullable().optional(),
  service_tier: nameSchema.nullable().optional(),
  status: z.enum(SESSION_STATUSES),
  unread: z.boolean().optional(),
  queue: z.strictObject({
    revision: boundedStringSchema,
    entries: z.array(remoteQueueEntrySchema).max(MAX_QUEUE_ENTRIES),
  }),
  updated_at: boundedStringSchema,
  active_turn: z.strictObject({
    id: canonicalIdSchema,
    turn_number: positiveSafeIntegerSchema,
  }).optional(),
});

export const remoteInteractionSchema = z.strictObject({
  id: canonicalIdSchema,
  revision: boundedStringSchema,
  session_id: canonicalIdSchema,
  turn_id: canonicalIdSchema,
  kind: z.enum(INTERACTION_KINDS),
  created_at: boundedStringSchema,
  presentation: z.strictObject({
    title: nameSchema,
    description: boundedStringSchema,
    risk: z.enum(['low', 'medium', 'high']),
    actions: z.array(z.strictObject({
      id: canonicalIdSchema,
      label: nameSchema,
      tone: z.enum(['default', 'danger']),
    })).max(16),
    subject: boundedStringSchema.optional(),
    inputs: z.array(z.strictObject({
      id: canonicalIdSchema,
      label: nameSchema,
      type: z.enum(['text', 'multiline_text', 'single_select', 'multi_select', 'boolean']),
      options: z.array(z.strictObject({
        value: boundedStringSchema,
        label: nameSchema,
        description: boundedStringSchema.optional(),
      })).max(32).optional(),
    })).max(16).optional(),
  }),
});

export const remoteAttentionSchema = z.strictObject({
  session_id: canonicalIdSchema,
  kind: z.enum(ATTENTION_KINDS),
  updated_at: boundedStringSchema,
});

export const remoteFileRefSchema = z.strictObject({
  id: canonicalIdSchema,
  session_id: canonicalIdSchema,
  name: nameSchema,
  mime: nameSchema,
  size: nonNegativeSafeIntegerSchema.max(MAX_ATTACHMENT_BYTES),
  revision: boundedStringSchema,
  previewable: z.boolean(),
  downloadable: z.boolean(),
  expires_at: boundedStringSchema,
});

export const remoteStateSnapshotSchema = z.strictObject({
  type: z.literal('state.snapshot'),
  snapshot_id: canonicalIdSchema,
  host_generation: canonicalIdSchema,
  revision: boundedStringSchema,
  event_sequence: nonNegativeSafeIntegerSchema,
  host: z.strictObject({
    id: canonicalIdSchema,
    name: nameSchema,
    online: z.literal(true),
    version: boundedStringSchema,
  }),
  workspaces: z.array(z.strictObject({
    id: canonicalIdSchema,
    name: nameSchema,
  })).max(MAX_ARRAY_ITEMS),
  tasks: z.array(remoteTaskSchema).max(MAX_ARRAY_ITEMS),
  sessions: z.array(remoteSessionSchema).max(MAX_ARRAY_ITEMS),
  interactions: z.array(remoteInteractionSchema).max(MAX_ARRAY_ITEMS),
  capabilities: effectiveCapabilitiesSchema,
  attention: z.array(remoteAttentionSchema).max(MAX_ARRAY_ITEMS),
  catalog_revision: boundedStringSchema,
});

export const remoteStatePatchBodySchema = z.strictObject({
  workspaces: z.strictObject({
    upsert: z.array(z.strictObject({ id: canonicalIdSchema, name: nameSchema })).max(MAX_ARRAY_ITEMS),
    remove_ids: z.array(canonicalIdSchema).max(MAX_ARRAY_ITEMS),
  }).optional(),
  tasks: z.strictObject({
    upsert: z.array(remoteTaskSchema).max(MAX_ARRAY_ITEMS),
    remove_ids: z.array(canonicalIdSchema).max(MAX_ARRAY_ITEMS),
  }).optional(),
  sessions: z.strictObject({
    upsert: z.array(remoteSessionSchema).max(MAX_ARRAY_ITEMS),
    remove_ids: z.array(canonicalIdSchema).max(MAX_ARRAY_ITEMS),
  }).optional(),
  interactions: z.strictObject({
    upsert: z.array(remoteInteractionSchema).max(MAX_ARRAY_ITEMS),
    remove_ids: z.array(canonicalIdSchema).max(MAX_ARRAY_ITEMS),
  }).optional(),
  queues: z.array(z.strictObject({
    session_id: canonicalIdSchema,
    queue_revision: boundedStringSchema,
    entries: z.array(remoteQueueEntrySchema).max(MAX_QUEUE_ENTRIES),
  })).max(MAX_ARRAY_ITEMS).optional(),
  capabilities: effectiveCapabilitiesSchema.optional(),
  attention: z.array(remoteAttentionSchema).max(MAX_ARRAY_ITEMS).optional(),
  catalog_invalidated: z.strictObject({
    catalog_revision: boundedStringSchema,
  }).optional(),
});

export const commandExpectedSchema = z.strictObject({
  host_generation: canonicalIdSchema,
  state_revision: boundedStringSchema.optional(),
  catalog_revision: boundedStringSchema.optional(),
  session_revision: boundedStringSchema.optional(),
  queue_revision: boundedStringSchema.optional(),
  interaction_id: canonicalIdSchema.optional(),
  interaction_revision: boundedStringSchema.optional(),
});

export const catalogReadParamsSchema = z.strictObject({});
export const stateRefreshParamsSchema = z.strictObject({
  session_id: canonicalIdSchema.optional(),
});
export const sessionSubscribeParamsSchema = z.strictObject({
  session_id: canonicalIdSchema,
});
export const sessionPageParamsSchema = z.strictObject({
  session_id: canonicalIdSchema,
  cursor: boundedStringSchema.optional(),
  turns: z.number().int().min(MIN_SESSION_PAGE_TURNS).max(MAX_SESSION_PAGE_TURNS).optional(),
});
export const commandStatusParamsSchema = z.strictObject({
  command_id: uuidV7Schema,
});
export const sessionCreateParamsSchema = z.strictObject({
  catalog_revision: boundedStringSchema,
  workspace_id: canonicalIdSchema,
  agent_id: canonicalIdSchema,
  task_id: canonicalIdSchema.optional(),
  name: nameSchema.optional(),
  model: nameSchema.optional(),
  thinking: nameSchema.optional(),
  service_tier: z.enum(['standard', 'fast']).optional(),
});
export const sessionUpdateParamsSchema = z.strictObject({
  session_id: canonicalIdSchema,
  session_revision: boundedStringSchema,
  name: nameSchema.optional(),
  model: nameSchema.optional(),
  thinking: nameSchema.optional(),
  service_tier: z.enum(['standard', 'fast']).optional(),
});
export const sessionSendParamsSchema = z.strictObject({
  session_id: canonicalIdSchema,
  text: boundedStringSchema,
  busy: z.enum(['queue', 'fail', 'steer']).optional(),
  items: z.array(remoteInputItemSchema).max(32).optional(),
  context_items: z.array(remoteContextItemSchema).max(32).optional(),
  composer_document: remoteComposerDocumentSchema.optional(),
});
export const sessionStopParamsSchema = z.strictObject({
  session_id: canonicalIdSchema,
  session_revision: boundedStringSchema,
});
export const queueUpdateParamsSchema = z.strictObject({
  session_id: canonicalIdSchema,
  queue_id: canonicalIdSchema,
  text: boundedStringSchema,
  expected_queue_revision: boundedStringSchema,
});
export const queueRemoveParamsSchema = z.strictObject({
  session_id: canonicalIdSchema,
  queue_id: canonicalIdSchema,
  expected_queue_revision: boundedStringSchema,
});
export const queueClearParamsSchema = z.strictObject({
  session_id: canonicalIdSchema,
  expected_queue_revision: boundedStringSchema,
});
export const queueSendNowParamsSchema = z.strictObject({
  session_id: canonicalIdSchema,
  expected_queue_revision: boundedStringSchema,
});
export const interactionRespondParamsSchema = z.strictObject({
  interaction_id: canonicalIdSchema,
  interaction_revision: boundedStringSchema,
  action_id: canonicalIdSchema,
  values: z.record(
    z.string().min(1).max(64),
    z.union([z.string().max(4000), z.boolean(), z.array(z.string().max(256)).max(16)]),
  ).optional(),
});
export const filePreviewParamsSchema = z.strictObject({
  handle_id: canonicalIdSchema,
});

export const REMOTE_METHOD_PARAMS = {
  'catalog.read': catalogReadParamsSchema,
  'state.refresh': stateRefreshParamsSchema,
  'session.subscribe': sessionSubscribeParamsSchema,
  'session.page': sessionPageParamsSchema,
  'command.status': commandStatusParamsSchema,
  'session.create': sessionCreateParamsSchema,
  'session.update': sessionUpdateParamsSchema,
  'session.send': sessionSendParamsSchema,
  'session.stop': sessionStopParamsSchema,
  'queue.update': queueUpdateParamsSchema,
  'queue.remove': queueRemoveParamsSchema,
  'queue.clear': queueClearParamsSchema,
  'queue.send_now': queueSendNowParamsSchema,
  'interaction.respond': interactionRespondParamsSchema,
  'file.preview': filePreviewParamsSchema,
} as const;

export const catalogReadResultSchema = z.strictObject({
  catalog_revision: boundedStringSchema,
  workspaces: z.array(z.strictObject({
    id: canonicalIdSchema,
    name: nameSchema,
  })).max(MAX_ARRAY_ITEMS),
  agents: z.array(z.strictObject({
    id: canonicalIdSchema,
    name: nameSchema,
    proxy: nameSchema,
    readiness: z.enum(['ready', 'unavailable']),
    defaults: z.strictObject({
      model: nameSchema.optional(),
      thinking: nameSchema.optional(),
      service_tier: z.enum(['standard', 'fast']).optional(),
    }).optional(),
    models: z.array(z.strictObject({
      id: nameSchema,
      label: nameSchema,
      is_default: z.boolean(),
      supported_thinking: z.array(nameSchema).max(32),
    })).max(MAX_ARRAY_ITEMS).optional(),
  })).max(MAX_ARRAY_ITEMS),
  tasks: z.array(z.strictObject({
    id: canonicalIdSchema,
    name: nameSchema,
  })).max(MAX_ARRAY_ITEMS),
});

export const commandStatusResultSchema = z.strictObject({
  command_id: uuidV7Schema,
  state: z.enum(COMMAND_STATUS_STATES),
  result: z.unknown().optional(),
  error: remoteCommandErrorSchema.optional(),
});

export const sessionStopResultSchema = z.strictObject({
  already_idle: z.boolean(),
  session_revision: boundedStringSchema,
});

export const queueReplacementResultSchema = z.strictObject({
  queue: z.array(remoteQueueEntrySchema).max(MAX_QUEUE_ENTRIES),
  queue_revision: boundedStringSchema,
});

export const filePreviewResultSchema = z.strictObject({
  transfer_id: canonicalIdSchema,
  file: remoteFileRefSchema,
  preview_max_bytes: z.literal(MAX_FILE_PREVIEW_BYTES),
});

const transcriptItemBaseSchema = {
  id: canonicalIdSchema,
  turn_id: canonicalIdSchema,
  turn: nonNegativeSafeIntegerSchema,
  ts: unixMsSchema,
};

/**
 * Closed, presentation-only transcript contract. Remote clients must receive
 * the same logical event kinds as local Web without exposing provider-native
 * payloads, absolute paths, stderr, stacks, or credentials.
 */
export const transcriptItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('user'),
    text: boundedStringSchema,
    attachments: z.array(remoteFileRefSchema).max(32).optional(),
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('assistant'),
    text: boundedStringSchema,
    delta: z.boolean(),
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('command'),
    status: z.enum(['running', 'success', 'error']),
    exit_code: z.number().int().optional(),
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('file-change'),
    file_count: nonNegativeSafeIntegerSchema,
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('file-read'),
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('file-search'),
    search_kind: z.enum(['glob', 'grep']),
    match_count: nonNegativeSafeIntegerSchema.optional(),
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('web-search'),
    result_count: nonNegativeSafeIntegerSchema.optional(),
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('tool'),
    name: nameSchema,
    status: z.enum(['pending', 'running', 'success', 'error']),
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('agent'),
    status: z.enum(['running', 'done', 'error']),
    agent_type: nameSchema.optional(),
    model: nameSchema.optional(),
    background: z.boolean().optional(),
    started_at: unixMsSchema,
    completed_at: unixMsSchema.optional(),
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('notice'),
    severity: z.enum(['info', 'warning', 'error']),
    code: nameSchema,
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('classifier-denied'),
    consecutive: nonNegativeSafeIntegerSchema,
    total: nonNegativeSafeIntegerSchema,
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('circuit-breaker'),
    trigger: z.enum(['consecutive', 'total']),
    consecutive: nonNegativeSafeIntegerSchema,
    total: nonNegativeSafeIntegerSchema,
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('turn-end'),
    outcome: z.enum(['worked', 'failed', 'stopped']),
    source_turn_id: boundedStringSchema.optional(),
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('error'),
  }),
]);

export const REMOTE_METHOD_RESULTS = {
  'catalog.read': catalogReadResultSchema,
  'state.refresh': remoteStateSnapshotSchema,
  'session.subscribe': z.strictObject({
    session: remoteSessionSchema,
    cursor: boundedStringSchema,
  }),
  'session.page': z.strictObject({
    session_id: canonicalIdSchema,
    cursor: boundedStringSchema.optional(),
    has_more: z.boolean(),
    items: z.array(transcriptItemSchema).max(MAX_ARRAY_ITEMS),
  }),
  'command.status': commandStatusResultSchema,
  'session.create': remoteSessionSchema,
  'session.update': remoteSessionSchema,
  'session.send': z.strictObject({
    session: remoteSessionSchema,
    delivery_id: canonicalIdSchema.optional(),
  }),
  'session.stop': sessionStopResultSchema,
  'queue.update': queueReplacementResultSchema,
  'queue.remove': queueReplacementResultSchema,
  'queue.clear': queueReplacementResultSchema,
  'queue.send_now': z.strictObject({
    mode: z.enum(['noop', 'started', 'steered']),
    queue: z.array(remoteQueueEntrySchema).max(MAX_QUEUE_ENTRIES),
    queue_revision: boundedStringSchema,
  }),
  'interaction.respond': z.strictObject({
    interaction_id: canonicalIdSchema,
    revision: boundedStringSchema,
    resolved: z.literal(true),
  }),
  'file.preview': filePreviewResultSchema,
} as const;

export function parseRemoteMethodParams(method: RemoteMethod, params: unknown): unknown {
  return parseClosed(REMOTE_METHOD_PARAMS[method] as z.ZodType<unknown>, params);
}

export const helloSchema = z.strictObject({
  type: z.literal('hello'),
  protocol: remoteProtocolSchema,
  client_version: boundedStringSchema,
  major_version: z.literal(REMOTE_MAJOR_VERSION),
  min_minor_version: nonNegativeSafeIntegerSchema,
  max_minor_version: nonNegativeSafeIntegerSchema,
  capabilities: z.array(wireFeatureIdSchema).max(MAX_HELLO_CAPABILITIES),
  device_id: canonicalIdSchema,
  last_host_generation: canonicalIdSchema.optional(),
  last_event_sequence: nonNegativeSafeIntegerSchema.optional(),
  current_revision: boundedStringSchema.optional(),
}).refine(
  (value) => value.min_minor_version <= value.max_minor_version,
  'min_minor_version must be <= max_minor_version.',
);

export const helloOkSchema = z.strictObject({
  type: z.literal('hello.ok'),
  protocol: remoteProtocolSchema,
  host_version: boundedStringSchema,
  host_generation: canonicalIdSchema,
  connection_id: canonicalIdSchema,
  negotiated_major_version: z.literal(REMOTE_MAJOR_VERSION),
  negotiated_minor_version: nonNegativeSafeIntegerSchema,
  negotiated_capabilities: z.array(wireFeatureSchema).max(MAX_HELLO_CAPABILITIES),
  server_time: unixMsSchema,
});

export const stateSnapshotPartSchema = z.strictObject({
  type: z.literal('state.snapshot.part'),
  snapshot_id: canonicalIdSchema,
  host_generation: canonicalIdSchema,
  revision: boundedStringSchema,
  event_sequence: nonNegativeSafeIntegerSchema,
  part_index: nonNegativeSafeIntegerSchema,
  part_total: positiveSafeIntegerSchema.max(MAX_SNAPSHOT_PARTS),
  payload_size: positiveSafeIntegerSchema.max(MAX_SNAPSHOT_TOTAL_BYTES),
  payload_sha256: sha256HexSchema,
  bytes: z.string().min(1),
});

export const resumeRequestSchema = z.strictObject({
  type: z.literal('resume.request'),
  host_generation: canonicalIdSchema,
  after_event_sequence: nonNegativeSafeIntegerSchema,
  current_revision: boundedStringSchema,
  subscribed_session_id: canonicalIdSchema.optional(),
  transcript_cursor: boundedStringSchema.optional(),
});

export const resumeOkSchema = z.strictObject({
  type: z.literal('resume.ok'),
  host_generation: canonicalIdSchema,
  replay_from: nonNegativeSafeIntegerSchema,
  replay_through: nonNegativeSafeIntegerSchema,
  revision: boundedStringSchema,
});

export const snapshotRequiredSchema = z.strictObject({
  type: z.literal('snapshot.required'),
  reason: z.enum(SNAPSHOT_REQUIRED_REASONS),
});

export const commandRequestSchema = z.strictObject({
  type: z.literal('command.request'),
  command_id: uuidV7Schema,
  created_at: unixMsSchema,
  attempt_id: canonicalIdSchema,
  method: remoteMethodSchema,
  params: z.unknown(),
  expected: commandExpectedSchema.optional(),
});

export const commandAcceptedSchema = z.strictObject({
  type: z.literal('command.accepted'),
  command_id: uuidV7Schema,
  attempt_id: canonicalIdSchema,
});

export const commandResultSchema = z.strictObject({
  type: z.literal('command.result'),
  command_id: uuidV7Schema,
  attempt_id: canonicalIdSchema,
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: remoteCommandErrorSchema.optional(),
});

export const remoteEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session.updated'), session: remoteSessionSchema }),
  z.strictObject({ kind: z.literal('interaction.updated'), interaction: remoteInteractionSchema }),
  z.strictObject({
    kind: z.literal('attention.updated'),
    attention: z.array(remoteAttentionSchema).max(MAX_ARRAY_ITEMS),
  }),
  z.strictObject({
    kind: z.literal('transcript.item'),
    session_id: canonicalIdSchema,
    item: transcriptItemSchema,
  }),
]);

export const canonicalEventSchema = z.strictObject({
  type: z.literal('event'),
  host_generation: canonicalIdSchema,
  event_sequence: nonNegativeSafeIntegerSchema,
  event: remoteEventSchema,
});

export const statePatchSchema = z.strictObject({
  type: z.literal('state.patch'),
  host_generation: canonicalIdSchema,
  event_sequence: nonNegativeSafeIntegerSchema,
  base_revision: boundedStringSchema,
  revision: boundedStringSchema,
  patch: remoteStatePatchBodySchema,
});

export const attachmentBeginSchema = z.strictObject({
  type: z.literal('attachment.begin'),
  transfer_id: canonicalIdSchema,
  upload_id: canonicalIdSchema,
  session_id: canonicalIdSchema,
  name: nameSchema,
  mime: nameSchema,
  size: positiveSafeIntegerSchema.max(MAX_ATTACHMENT_BYTES),
  sha256: sha256HexSchema,
});

export const attachmentChunkSchema = z.strictObject({
  type: z.literal('attachment.chunk'),
  transfer_id: canonicalIdSchema,
  transfer_sequence: nonNegativeSafeIntegerSchema,
  offset: nonNegativeSafeIntegerSchema,
  bytes: z.string().min(1),
});

export const transferAckSchema = z.strictObject({
  type: z.literal('transfer.ack'),
  transfer_id: canonicalIdSchema,
  contiguous_offset: nonNegativeSafeIntegerSchema,
  window_chunks: z.number().int().min(1).max(CONTENT_WINDOW_CHUNKS),
});

export const transferCancelSchema = z.strictObject({
  type: z.literal('transfer.cancel'),
  transfer_id: canonicalIdSchema,
  reason: boundedStringSchema,
});

export const transferErrorSchema = z.strictObject({
  type: z.literal('transfer.error'),
  transfer_id: canonicalIdSchema,
  code: remoteErrorCodeSchema,
  message: boundedStringSchema,
});

export const attachmentCompleteSchema = z.strictObject({
  type: z.literal('attachment.complete'),
  transfer_id: canonicalIdSchema,
  upload_id: canonicalIdSchema,
});

export const attachmentResultSchema = z.strictObject({
  type: z.literal('attachment.result'),
  transfer_id: canonicalIdSchema,
  upload_id: canonicalIdSchema,
  attachment_id: canonicalIdSchema,
  name: nameSchema,
  mime: nameSchema,
  size: positiveSafeIntegerSchema.max(MAX_ATTACHMENT_BYTES),
  sha256: sha256HexSchema,
  expires_at: boundedStringSchema,
});

export const downloadRequestSchema = z.strictObject({
  type: z.literal('download.request'),
  transfer_id: canonicalIdSchema,
  kind: z.enum(DOWNLOAD_KINDS),
  handle_id: canonicalIdSchema,
  offset: nonNegativeSafeIntegerSchema.optional(),
});

export const downloadMetadataSchema = z.strictObject({
  type: z.literal('download.metadata'),
  transfer_id: canonicalIdSchema,
  name: nameSchema,
  mime: nameSchema,
  size: nonNegativeSafeIntegerSchema.max(MAX_ATTACHMENT_BYTES),
  sha256: sha256HexSchema,
  disposition: z.enum(['inline', 'attachment']),
  preview: z.boolean(),
});

export const downloadCompleteSchema = z.strictObject({
  type: z.literal('download.complete'),
  transfer_id: canonicalIdSchema,
  size: nonNegativeSafeIntegerSchema,
  sha256: sha256HexSchema,
});

export const remoteErrorMessageSchema = z.strictObject({
  type: z.literal('error'),
  code: remoteErrorCodeSchema,
  message: boundedStringSchema,
  command_id: uuidV7Schema.optional(),
  attempt_id: canonicalIdSchema.optional(),
});

export const remoteControlMessageSchema = z.discriminatedUnion('type', [
  helloSchema,
  helloOkSchema,
  remoteStateSnapshotSchema,
  stateSnapshotPartSchema,
  resumeRequestSchema,
  resumeOkSchema,
  snapshotRequiredSchema,
  commandRequestSchema,
  commandAcceptedSchema,
  commandResultSchema,
  canonicalEventSchema,
  statePatchSchema,
  attachmentBeginSchema,
  attachmentChunkSchema,
  attachmentCompleteSchema,
  attachmentResultSchema,
  transferAckSchema,
  transferCancelSchema,
  transferErrorSchema,
  downloadRequestSchema,
  downloadMetadataSchema,
  downloadCompleteSchema,
  remoteErrorMessageSchema,
]);

export type RemoteMethod = (typeof REMOTE_METHODS)[number];
export type Hello = z.infer<typeof helloSchema>;
export type HelloOk = z.infer<typeof helloOkSchema>;
export type RemoteStateSnapshot = z.infer<typeof remoteStateSnapshotSchema>;
export type StateSnapshotPart = z.infer<typeof stateSnapshotPartSchema>;
export type ResumeRequest = z.infer<typeof resumeRequestSchema>;
export type ResumeOk = z.infer<typeof resumeOkSchema>;
export type SnapshotRequired = z.infer<typeof snapshotRequiredSchema>;
export type CommandRequest = z.infer<typeof commandRequestSchema>;
export type CommandAccepted = z.infer<typeof commandAcceptedSchema>;
export type CommandResult = z.infer<typeof commandResultSchema>;
export type CommandStatusResult = z.infer<typeof commandStatusResultSchema>;
export type CanonicalEvent = z.infer<typeof canonicalEventSchema>;
export type StatePatch = z.infer<typeof statePatchSchema>;
export type RemoteStatePatch = z.infer<typeof remoteStatePatchBodySchema>;
export type RemoteControlMessage = z.infer<typeof remoteControlMessageSchema>;
export type RemoteSession = z.infer<typeof remoteSessionSchema>;
export type RemoteTask = z.infer<typeof remoteTaskSchema>;
export type RemoteQueueEntry = z.infer<typeof remoteQueueEntrySchema>;
export type RemoteAttention = z.infer<typeof remoteAttentionSchema>;
export type RemoteInteraction = z.infer<typeof remoteInteractionSchema>;
export type EffectiveCapabilities = z.infer<typeof effectiveCapabilitiesSchema>;
export type RemoteTranscriptItem = z.infer<typeof transcriptItemSchema>;

export function parseRemoteControlMessage(value: unknown): RemoteControlMessage {
  return parseClosed(remoteControlMessageSchema, value);
}

export const CONTENT_INNER_MESSAGE_TYPES = ['attachment.chunk'] as const;

export const CONTROL_INNER_MESSAGE_TYPES = [
  'hello',
  'hello.ok',
  'state.snapshot',
  'state.snapshot.part',
  'resume.request',
  'resume.ok',
  'snapshot.required',
  'command.request',
  'command.accepted',
  'command.result',
  'event',
  'state.patch',
  'attachment.begin',
  'attachment.complete',
  'attachment.result',
  'transfer.ack',
  'transfer.cancel',
  'transfer.error',
  'download.request',
  'download.metadata',
  'download.complete',
  'error',
] as const;

export function expectedFrameClassForInnerType(
  innerType: string | undefined,
): 'control' | 'content' | undefined {
  if (!innerType) return undefined;
  if ((CONTENT_INNER_MESSAGE_TYPES as readonly string[]).includes(innerType)) return 'content';
  if ((CONTROL_INNER_MESSAGE_TYPES as readonly string[]).includes(innerType)) return 'control';
  return undefined;
}

export function assertFrameClassMatchesInner(
  frameClass: 'control' | 'content',
  innerType: string | undefined,
): void {
  const expected = expectedFrameClassForInnerType(innerType);
  if (!expected) {
    throw new RemoteProtocolError(
      'INVALID_FRAME',
      innerType ? `unknown inner message type: ${innerType}` : 'inner message type is required',
      { reason: innerType ? 'unknown_inner_type' : 'frame_class_mismatch' },
    );
  }
  if (frameClass !== expected) {
    throw new RemoteProtocolError(
      'INVALID_FRAME',
      `frame_class ${frameClass} does not match inner type ${innerType}`,
      { reason: 'frame_class_mismatch' },
    );
  }
}

export function parseCommandRequest(value: unknown, now: number): CommandRequest {
  const command = parseClosed(commandRequestSchema, value);
  validateCommandIdentity(command.command_id, command.created_at, now);
  parseRemoteMethodParams(command.method, command.params);
  return command;
}

export interface HelloNegotiationInput {
  peer_min_minor: number;
  peer_max_minor: number;
  local_min_minor?: number;
  local_max_minor?: number;
  peer_capabilities: string[];
  local_capabilities?: readonly string[];
}

export function negotiateHello(input: HelloNegotiationInput): {
  negotiated_minor_version: number;
  negotiated_capabilities: Array<(typeof WIRE_FEATURES)[number]>;
} {
  const localMin = input.local_min_minor ?? REMOTE_MIN_MINOR_VERSION;
  const localMax = input.local_max_minor ?? REMOTE_MAX_MINOR_VERSION;
  const overlapMin = Math.max(localMin, input.peer_min_minor);
  const overlapMax = Math.min(localMax, input.peer_max_minor);
  if (overlapMin > overlapMax) {
    throw new RemoteProtocolError('PROTOCOL_VERSION_UNSUPPORTED', 'minor version ranges do not overlap.');
  }
  const localCaps = new Set(input.local_capabilities ?? WIRE_FEATURES);
  const negotiated = WIRE_FEATURES.filter((id) => (
    localCaps.has(id) && input.peer_capabilities.includes(id)
  ));
  return {
    negotiated_minor_version: overlapMax,
    negotiated_capabilities: negotiated,
  };
}

export interface SnapshotPartAssembly {
  snapshot_id: string;
  host_generation: string;
  revision: string;
  event_sequence: number;
  part_total: number;
  payload_size: number;
  payload_sha256: string;
  parts: Map<number, string>;
}

export function createSnapshotPartAssembly(part: StateSnapshotPart): SnapshotPartAssembly {
  if (part.part_index >= part.part_total) {
    throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'snapshot part index is out of range.');
  }
  const parts = new Map<number, string>();
  parts.set(part.part_index, part.bytes);
  return {
    snapshot_id: part.snapshot_id,
    host_generation: part.host_generation,
    revision: part.revision,
    event_sequence: part.event_sequence,
    part_total: part.part_total,
    payload_size: part.payload_size,
    payload_sha256: part.payload_sha256,
    parts,
  };
}

export function addSnapshotPart(assembly: SnapshotPartAssembly, part: StateSnapshotPart): void {
  if (
    part.snapshot_id !== assembly.snapshot_id
    || part.host_generation !== assembly.host_generation
    || part.revision !== assembly.revision
    || part.event_sequence !== assembly.event_sequence
    || part.part_total !== assembly.part_total
    || part.payload_size !== assembly.payload_size
    || part.payload_sha256 !== assembly.payload_sha256
  ) {
    throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'snapshot part metadata conflict.');
  }
  if (part.part_index >= assembly.part_total) {
    throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'snapshot part index is out of range.');
  }
  const existing = assembly.parts.get(part.part_index);
  if (existing && existing !== part.bytes) {
    throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'snapshot part duplicate conflict.');
  }
  assembly.parts.set(part.part_index, part.bytes);
}

export async function finalizeSnapshotParts(assembly: SnapshotPartAssembly): Promise<RemoteStateSnapshot> {
  if (assembly.parts.size !== assembly.part_total) {
    throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'snapshot parts are incomplete.');
  }
  const chunks: Uint8Array[] = [];
  for (let index = 0; index < assembly.part_total; index += 1) {
    const encoded = assembly.parts.get(index);
    if (!encoded) {
      throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'snapshot part is missing.');
    }
    chunks.push(base64UrlToBytes(encoded));
  }
  const payload = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (payload.byteLength !== assembly.payload_size || payload.byteLength > MAX_SNAPSHOT_TOTAL_BYTES) {
    throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'snapshot payload size mismatch.');
  }
  const digest = await sha256Hex(payload);
  if (digest !== assembly.payload_sha256) {
    throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'snapshot payload hash mismatch.');
  }
  return parseClosed(remoteStateSnapshotSchema, JSON.parse(new TextDecoder().decode(payload)));
}

export async function splitSnapshotParts(
  snapshot: RemoteStateSnapshot,
  maxPartBytes: number,
): Promise<StateSnapshotPart[]> {
  const payload = new TextEncoder().encode(canonicalJson(snapshot));
  if (payload.byteLength > MAX_SNAPSHOT_TOTAL_BYTES) {
    throw new RemoteProtocolError('FRAME_TOO_LARGE', 'snapshot exceeds the assembly limit.');
  }
  const digest = await sha256Hex(payload);
  const partTotal = Math.max(1, Math.ceil(payload.byteLength / maxPartBytes));
  if (partTotal > MAX_SNAPSHOT_PARTS) {
    throw new RemoteProtocolError('FRAME_TOO_LARGE', 'snapshot requires too many parts.');
  }
  const parts: StateSnapshotPart[] = [];
  for (let index = 0; index < partTotal; index += 1) {
    const start = index * maxPartBytes;
    const bytes = payload.slice(start, start + maxPartBytes);
    parts.push(parseClosed(stateSnapshotPartSchema, {
      type: 'state.snapshot.part',
      snapshot_id: snapshot.snapshot_id,
      host_generation: snapshot.host_generation,
      revision: snapshot.revision,
      event_sequence: snapshot.event_sequence,
      part_index: index,
      part_total: partTotal,
      payload_size: payload.byteLength,
      payload_sha256: digest,
      bytes: bytesToBase64Url(bytes),
    }));
  }
  return parts;
}

export function applyStatePatch(
  current: { host_generation: string; revision: string; event_sequence: number },
  patch: StatePatch,
): { revision: string; event_sequence: number } {
  if (patch.host_generation !== current.host_generation) {
    throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'host generation changed.');
  }
  if (patch.base_revision !== current.revision) {
    throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'state patch base revision mismatch.');
  }
  if (patch.event_sequence !== current.event_sequence + 1) {
    throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'state patch event sequence gap.');
  }
  return {
    revision: patch.revision,
    event_sequence: patch.event_sequence,
  };
}

export const CONTENT_CHUNK_JSON_OVERHEAD_BYTES = 256;

export function contentChunkRawByteLimit(
  overheadBytes = CONTENT_CHUNK_JSON_OVERHEAD_BYTES,
): number {
  if (overheadBytes >= MAX_CONTENT_CHUNK_PLAINTEXT_BYTES) {
    throw new RemoteProtocolError('FRAME_TOO_LARGE', 'content chunk overhead exceeds the plaintext limit.');
  }
  return Math.floor((MAX_CONTENT_CHUNK_PLAINTEXT_BYTES - overheadBytes) * 3 / 4);
}

export function assertContentChunkLimit(bytes: string): void {
  if (utf8ByteLength(bytes) > MAX_CONTENT_CHUNK_PLAINTEXT_BYTES) {
    throw new RemoteProtocolError('FRAME_TOO_LARGE', 'content chunk exceeds 256 KiB.');
  }
}

export function assertInnerContentPlaintext(message: object): void {
  if (utf8ByteLength(JSON.stringify(message)) > MAX_CONTENT_CHUNK_PLAINTEXT_BYTES) {
    throw new RemoteProtocolError('FRAME_TOO_LARGE', 'content inner plaintext exceeds 256 KiB.');
  }
}

export function parseContentChunk(value: unknown): z.infer<typeof attachmentChunkSchema> {
  const chunk = parseClosed(attachmentChunkSchema, value);
  assertContentChunkLimit(chunk.bytes);
  return chunk;
}

export const REMOTE_PROTOCOL_NAME = REMOTE_PROTOCOL;
export const REMOTE_METHOD_LIST = REMOTE_METHODS;
export const BUSINESS_CAPABILITY_LIST = BUSINESS_CAPABILITY_IDS;
