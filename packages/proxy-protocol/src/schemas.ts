import { z } from 'zod';

import {
  APPROVAL_OPTION_KINDS,
  CONTENT_KINDS,
  PROCESS_SCOPES,
  PROTOCOL_ERROR_CODES,
  PROTOCOL_NAME,
  PROTOCOL_V1,
  SESSION_STATUSES,
  STOP_REASONS,
} from './constants.js';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const safeIntegerSchema = z.number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const nonNegativeSafeIntegerSchema = safeIntegerSchema.min(0);
const positiveSafeIntegerSchema = safeIntegerSchema.min(1);
const nonEmptyStringSchema = z.string().min(1);
const isoDateTimeSchema = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)),
  'Expected an ISO-8601 timestamp.',
);

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

export const wireIdSchema = z.union([nonEmptyStringSchema, safeIntegerSchema]);

const pluginIdSchema = nonEmptyStringSchema.regex(
  /^(?:claude|codex|kimi|grok|[a-z0-9]+(?:[.-][a-z0-9]+)+)$/,
  'Expected a reserved built-in ID or reverse-domain external plugin ID.',
);
const semverSchema = nonEmptyStringSchema.regex(
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  'Expected a SemVer version.',
);

export const manifestV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  id: pluginIdSchema,
  displayName: nonEmptyStringSchema,
  pluginVersion: semverSchema,
  entry: nonEmptyStringSchema
    .regex(/^[^/\\]+$/, 'entry must name a directly contained file.')
    .refine((value) => value !== '.' && value !== '..', 'entry cannot be a dot path.'),
  protocol: z.strictObject({
    name: z.literal(PROTOCOL_NAME),
    range: nonEmptyStringSchema,
  }),
  process: z.strictObject({
    scope: z.enum(PROCESS_SCOPES),
  }),
  runtime: z.strictObject({
    id: nonEmptyStringSchema,
    displayName: nonEmptyStringSchema,
  }).optional(),
});

export const capabilitiesSchema = z.record(
  nonEmptyStringSchema,
  positiveSafeIntegerSchema,
);

export const initializeParamsSchema = z.strictObject({
  protocol: z.strictObject({
    name: z.literal(PROTOCOL_NAME),
    versions: z.array(nonEmptyStringSchema).min(1),
  }),
  host: z.strictObject({
    name: nonEmptyStringSchema,
    version: nonEmptyStringSchema,
  }),
});

export const initializeResultSchema = z.strictObject({
  protocol: z.strictObject({
    name: z.literal(PROTOCOL_NAME),
    version: z.literal(PROTOCOL_V1),
  }),
  plugin: z.strictObject({
    id: pluginIdSchema,
    name: nonEmptyStringSchema,
    version: semverSchema,
  }),
  process: z.strictObject({
    scope: z.enum(PROCESS_SCOPES),
  }),
  capabilities: capabilitiesSchema,
});

const configValueSchema = z.union([
  z.string(),
  z.boolean(),
  z.number().finite(),
  z.null(),
]);

export const configOptionSchema = z.strictObject({
  id: nonEmptyStringSchema,
  displayName: nonEmptyStringSchema,
  description: z.string().optional(),
  type: z.enum(['select', 'boolean', 'number', 'text']),
  scope: z.enum(['session', 'turn']),
  currentValue: configValueSchema,
  choices: z.array(z.strictObject({
    value: configValueSchema,
    displayName: nonEmptyStringSchema,
    description: z.string().optional(),
    group: z.string().optional(),
  })).optional(),
}).superRefine((option, context) => {
  if (option.type === 'select' && (!option.choices || option.choices.length === 0)) {
    context.addIssue({ code: 'custom', message: 'Select options require at least one choice.' });
  }
  if (option.type !== 'select' && option.choices !== undefined) {
    context.addIssue({ code: 'custom', message: 'Only select options can provide choices.' });
  }
  if (
    option.type === 'select'
    && option.currentValue !== null
    && !option.choices?.some(choice => Object.is(choice.value, option.currentValue))
  ) {
    context.addIssue({ code: 'custom', message: 'Select currentValue must be an advertised choice.' });
  }
  if (option.currentValue !== null) {
    const valid = option.type === 'boolean'
      ? typeof option.currentValue === 'boolean'
      : option.type === 'number'
        ? typeof option.currentValue === 'number'
        : option.type === 'text'
          ? typeof option.currentValue === 'string'
          : true;
    if (!valid) {
      context.addIssue({ code: 'custom', message: `currentValue does not match ${option.type}.` });
    }
  }
});

const effortSchema = z.strictObject({
  id: nonEmptyStringSchema,
  displayName: nonEmptyStringSchema,
  isDefault: z.boolean(),
});

const modelSchema = z.strictObject({
  id: nonEmptyStringSchema,
  displayName: nonEmptyStringSchema,
  description: z.string(),
  hidden: z.boolean(),
  isDefault: z.boolean(),
  efforts: z.array(effortSchema),
  input: z.array(z.enum(['text', 'localFile', 'localImage', 'skill'])).min(1),
});

const modeSchema = z.strictObject({
  id: nonEmptyStringSchema,
  displayName: nonEmptyStringSchema,
  description: z.string(),
  isDefault: z.boolean(),
  approval: z.enum(['relay', 'auto', 'never']),
  workspace: z.enum(['read-only', 'workspace-write', 'full-access']),
  network: z.enum(['deny', 'ask', 'allow']),
});

export const catalogResultSchema = z.strictObject({
  models: z.array(modelSchema),
  modes: z.array(modeSchema),
  sessionOptions: z.array(configOptionSchema),
});

const nativeSessionRefSchema = z.strictObject({
  id: nonEmptyStringSchema,
  mode: z.enum(['load', 'resume']).optional(),
});

export const sessionSchema = z.strictObject({
  id: nonEmptyStringSchema,
  nativeSession: z.strictObject({ id: nonEmptyStringSchema }).optional(),
  streamId: nonEmptyStringSchema,
  status: z.enum(SESSION_STATUSES),
  model: z.string().nullable().optional(),
  mode: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  configOptions: z.array(configOptionSchema).optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

const textInputSchema = z.strictObject({
  type: z.literal('text'),
  text: z.string(),
});
const localFileInputSchema = z.strictObject({
  type: z.literal('localFile'),
  path: nonEmptyStringSchema,
  name: z.string().optional(),
  mime: z.string().optional(),
  size: nonNegativeSafeIntegerSchema.optional(),
});
const localImageInputSchema = z.strictObject({
  type: z.literal('localImage'),
  path: nonEmptyStringSchema,
  name: z.string().optional(),
  mime: z.string().optional(),
  size: nonNegativeSafeIntegerSchema.optional(),
});
const skillInputSchema = z.strictObject({
  type: z.literal('skill'),
  name: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
});

export const inputItemSchema = z.discriminatedUnion('type', [
  textInputSchema,
  localFileInputSchema,
  localImageInputSchema,
  skillInputSchema,
]);

const sessionCreateParamsSchema = z.strictObject({
  sessionId: nonEmptyStringSchema,
  cwd: nonEmptyStringSchema,
  workspaceRoots: z.array(nonEmptyStringSchema).min(1),
  model: z.string().nullable().optional(),
  mode: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  nativeSession: nativeSessionRefSchema.optional(),
  config: z.record(nonEmptyStringSchema, configValueSchema),
});

const sessionAndStreamSchema = z.strictObject({
  sessionId: nonEmptyStringSchema,
  streamId: nonEmptyStringSchema,
});

export const turnStartParamsSchema = z.strictObject({
  sessionId: nonEmptyStringSchema,
  streamId: nonEmptyStringSchema,
  turnId: nonEmptyStringSchema,
  input: z.array(inputItemSchema).min(1),
  policy: z.strictObject({
    workspaceRoots: z.array(nonEmptyStringSchema).min(1),
    approval: z.enum(['relay', 'auto', 'never']),
    network: z.enum(['deny', 'ask', 'allow']),
  }),
  config: z.strictObject({
    model: z.string().nullable().optional(),
    mode: z.string().nullable().optional(),
    effort: z.string().nullable().optional(),
    native: z.record(nonEmptyStringSchema, configValueSchema),
  }),
});

const interruptParamsSchema = sessionAndStreamSchema.extend({
  turnId: nonEmptyStringSchema,
});

const slashArgHintSchema = z.strictObject({
  kind: z.enum(['free', 'model', 'path', 'agent', 'enum']),
  values: z.array(z.string()).optional(),
  placeholder: z.string().optional(),
}).superRefine((value, context) => {
  if (value.kind !== 'enum' && value.values !== undefined) {
    context.addIssue({
      code: 'custom',
      message: 'Only enum slash arguments can provide values.',
    });
  }
});

const slashCommandSchema = z.strictObject({
  name: nonEmptyStringSchema.regex(/^\//, 'Slash command names must start with /.'),
  description: z.string(),
  source: z.enum(['builtin', 'user', 'project']),
  argHints: z.array(slashArgHintSchema),
});

const nativeSessionListParamsSchema = z.strictObject({
  cwd: z.string().optional(),
  cursor: z.string().nullable().optional(),
  limit: positiveSafeIntegerSchema.max(500).optional(),
});

const nativeSessionSummarySchema = z.strictObject({
  id: nonEmptyStringSchema,
  displayName: z.string().optional(),
  cwd: z.string().optional(),
  updatedAt: isoDateTimeSchema.optional(),
});

const approvalRespondParamsSchema = interruptParamsSchema.extend({
  approvalId: nonEmptyStringSchema,
  optionId: nonEmptyStringSchema,
  answers: z.record(z.string(), z.union([
    z.string(),
    z.array(z.string()),
  ])).optional(),
});

const emptyParamsSchema = z.strictObject({});

function requestSchema<M extends string, S extends z.ZodType>(
  method: M,
  params: S,
) {
  return z.strictObject({
    id: wireIdSchema,
    method: z.literal(method),
    params,
  });
}

export const proxyRequestSchema = z.discriminatedUnion('method', [
  requestSchema('initialize', initializeParamsSchema),
  requestSchema('catalog.list', emptyParamsSchema),
  requestSchema('session.create', sessionCreateParamsSchema),
  requestSchema('session.get', z.strictObject({ sessionId: nonEmptyStringSchema })),
  requestSchema('turn.start', turnStartParamsSchema),
  requestSchema('turn.interrupt', interruptParamsSchema),
  requestSchema('session.close', sessionAndStreamSchema),
  requestSchema('shutdown', emptyParamsSchema),
  requestSchema('slash.list', sessionAndStreamSchema),
  requestSchema('session.rename', sessionAndStreamSchema.extend({
    name: z.string().refine(
      value => [...value].length <= 200,
      'Session name must not exceed 200 Unicode code points.',
    ),
  })),
  requestSchema('session.native.list', nativeSessionListParamsSchema),
  requestSchema('session.replay', sessionAndStreamSchema.extend({
    cursor: z.string().nullable(),
    limit: positiveSafeIntegerSchema.max(500),
  })),
  requestSchema('session.config.set', sessionAndStreamSchema.extend({
    optionId: nonEmptyStringSchema,
    value: configValueSchema,
  })),
  requestSchema('turn.steer', interruptParamsSchema.extend({
    input: z.array(inputItemSchema).min(1),
  })),
  requestSchema('approval.respond', approvalRespondParamsSchema),
]);

export const protocolErrorSchema = z.strictObject({
  code: z.enum(PROTOCOL_ERROR_CODES),
  message: nonEmptyStringSchema,
  retryable: z.boolean(),
  data: z.record(z.string(), jsonValueSchema),
});

export const proxyErrorResponseSchema = z.strictObject({
  id: wireIdSchema,
  error: protocolErrorSchema,
});

export const proxySuccessResponseEnvelopeSchema = z.strictObject({
  id: wireIdSchema,
  result: z.unknown(),
});

const okResultSchema = z.strictObject({ ok: z.literal(true) });
const sessionResultSchema = z.strictObject({ session: sessionSchema });
const acceptedTurnResultSchema = z.strictObject({
  accepted: z.literal(true),
  turnId: nonEmptyStringSchema,
});

const eventErrorSchema = z.strictObject({
  code: z.enum(PROTOCOL_ERROR_CODES),
  message: nonEmptyStringSchema,
  retryable: z.boolean(),
  data: z.record(z.string(), jsonValueSchema),
});

const contentKindSchema = z.enum(CONTENT_KINDS);
const approvalKindSchema = z.enum(APPROVAL_OPTION_KINDS);

const sessionEventFields = {
  eventId: nonEmptyStringSchema,
  streamId: nonEmptyStringSchema,
  sequence: positiveSafeIntegerSchema,
  sessionId: nonEmptyStringSchema,
  emittedAt: isoDateTimeSchema,
};
const turnEventFields = {
  ...sessionEventFields,
  turnId: nonEmptyStringSchema,
};

function sessionNotificationSchema<M extends string, S extends z.ZodType>(
  method: M,
  data: S,
) {
  return z.strictObject({
    method: z.literal(method),
    params: z.strictObject({
      ...sessionEventFields,
      data,
    }),
  });
}

function turnNotificationSchema<M extends string, S extends z.ZodType>(
  method: M,
  data: S,
) {
  return z.strictObject({
    method: z.literal(method),
    params: z.strictObject({
      ...turnEventFields,
      data,
    }),
  });
}

const sessionUpdatedDataSchema = z.strictObject({
  nativeSession: z.strictObject({ id: nonEmptyStringSchema }).optional(),
  status: z.enum(SESSION_STATUSES).optional(),
  model: z.string().nullable().optional(),
  mode: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  configOptions: z.array(configOptionSchema).optional(),
  reason: z.enum([
    'native-session-rotated',
    'native-history-changed',
    'runtime-state-changed',
    'configuration-changed',
  ]).optional(),
  updatedAt: isoDateTimeSchema.optional(),
}).refine(
  (value) => Object.keys(value).length > 0,
  'session.updated must contain at least one changed field.',
);

const contentDeltaDataSchema = z.strictObject({
  contentId: nonEmptyStringSchema,
  kind: contentKindSchema,
  delta: z.string(),
});
const contentCompletedDataSchema = z.strictObject({
  contentId: nonEmptyStringSchema,
  kind: contentKindSchema,
  content: z.string().optional(),
});
const inputRecordedDataSchema = z.strictObject({
  inputId: nonEmptyStringSchema,
  input: z.array(inputItemSchema).min(1),
});

const toolStartedDataSchema = z.strictObject({
  toolCallId: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  title: z.string().optional(),
  input: jsonValueSchema.optional(),
});
const toolUpdatedDataSchema = z.strictObject({
  toolCallId: nonEmptyStringSchema,
  outputDelta: z.string().optional(),
  statusText: z.string().optional(),
  data: jsonValueSchema.optional(),
});
const toolCompletedDataSchema = z.strictObject({
  toolCallId: nonEmptyStringSchema,
  status: z.enum(['succeeded', 'failed', 'interrupted']),
  output: jsonValueSchema.optional(),
  error: eventErrorSchema.optional(),
});

const approvalOptionSchema = z.strictObject({
  id: nonEmptyStringSchema,
  label: nonEmptyStringSchema,
  kind: approvalKindSchema,
});
const approvalRequestedDataSchema = z.strictObject({
  approvalId: nonEmptyStringSchema,
  category: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  description: z.string(),
  options: z.array(approvalOptionSchema).min(1),
  payload: jsonValueSchema,
});
const approvalResolvedDataSchema = z.strictObject({
  approvalId: nonEmptyStringSchema,
  resolution: z.enum([
    'selected',
    'turn_interrupted',
    'session_closed',
    'runtime_cancelled',
  ]),
  resolvedBy: z.enum(['user', 'proxy', 'runtime']),
  optionId: nonEmptyStringSchema.optional(),
}).superRefine((value, context) => {
  if (value.resolution === 'selected' && value.optionId === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'Selected approvals require optionId.',
    });
  }
  if (value.resolution !== 'selected' && value.optionId !== undefined) {
    context.addIssue({
      code: 'custom',
      message: 'Only selected approvals can include optionId.',
    });
  }
});

const planUpdatedDataSchema = z.strictObject({
  planId: nonEmptyStringSchema,
  title: z.string(),
  steps: z.array(z.strictObject({
    id: nonEmptyStringSchema,
    text: nonEmptyStringSchema,
    status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
  })),
});

const diffUpdatedDataSchema = z.strictObject({
  diffId: nonEmptyStringSchema,
  diff: z.string(),
  files: z.array(z.strictObject({
    path: nonEmptyStringSchema,
    status: z.enum(['added', 'modified', 'deleted', 'renamed']),
  })).optional(),
});

export const usageDataSchema = z.strictObject({
  context: z.union([
    z.strictObject({
      used: nonNegativeSafeIntegerSchema,
      window: positiveSafeIntegerSchema.optional(),
    }),
    z.null(),
  ]).optional(),
  conversation: z.discriminatedUnion('mode', [
    z.strictObject({
      mode: z.literal('absolute'),
      inputTokens: nonNegativeSafeIntegerSchema.optional(),
      outputTokens: nonNegativeSafeIntegerSchema.optional(),
      cachedInputTokens: nonNegativeSafeIntegerSchema.optional(),
      totalTokens: nonNegativeSafeIntegerSchema.optional(),
    }),
    z.strictObject({
      mode: z.literal('delta'),
      inputTokens: nonNegativeSafeIntegerSchema.optional(),
      outputTokens: nonNegativeSafeIntegerSchema.optional(),
      cachedInputTokens: nonNegativeSafeIntegerSchema.optional(),
      totalTokens: nonNegativeSafeIntegerSchema.optional(),
    }),
    z.strictObject({
      mode: z.literal('reset'),
    }),
  ]).optional(),
  reason: z.enum(['compact_started', 'session_reset']).optional(),
}).refine(
  (value) => value.context !== undefined
    || value.conversation !== undefined
    || value.reason !== undefined,
  'usage.updated must change at least one usage field.',
);

const agentUpdatedDataSchema = z.strictObject({
  agentId: nonEmptyStringSchema,
  status: z.enum(['running', 'completed', 'failed', 'interrupted']),
  description: z.string(),
  agentType: z.string().optional(),
  model: z.string().optional(),
  output: z.string().optional(),
});

const noticeCreatedDataSchema = z.strictObject({
  noticeId: nonEmptyStringSchema,
  severity: z.enum(['info', 'warning', 'error']),
  code: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  message: z.string(),
});

const extensionEventDataSchema = z.strictObject({
  namespace: pluginIdSchema,
  name: nonEmptyStringSchema,
  schemaVersion: positiveSafeIntegerSchema,
  payload: jsonValueSchema,
});

const sessionRuntimeErrorSchema = sessionNotificationSchema(
  'runtime.error',
  eventErrorSchema,
);
const processRuntimeErrorSchema = z.strictObject({
  method: z.literal('runtime.error'),
  params: z.strictObject({
    eventId: nonEmptyStringSchema,
    emittedAt: isoDateTimeSchema,
    data: eventErrorSchema,
  }),
});

const usageNotificationSchema = z.union([
  sessionNotificationSchema('usage.updated', usageDataSchema),
  turnNotificationSchema('usage.updated', usageDataSchema),
]).superRefine((value, context) => {
  const conversation = value.params.data.conversation;
  if (conversation?.mode === 'delta' && !('turnId' in value.params)) {
    context.addIssue({
      code: 'custom',
      message: 'Delta conversation usage requires turnId.',
    });
  }
});

export const proxyNotificationSchema = z.union([
  turnNotificationSchema('turn.started', z.strictObject({})),
  turnNotificationSchema('input.recorded', inputRecordedDataSchema),
  turnNotificationSchema('content.delta', contentDeltaDataSchema),
  turnNotificationSchema('content.completed', contentCompletedDataSchema),
  sessionNotificationSchema('session.updated', sessionUpdatedDataSchema),
  turnNotificationSchema('turn.completed', z.strictObject({
    stopReason: z.enum(STOP_REASONS),
  })),
  turnNotificationSchema('turn.failed', z.strictObject({
    error: eventErrorSchema,
  })),
  sessionRuntimeErrorSchema,
  processRuntimeErrorSchema,
  turnNotificationSchema('tool.started', toolStartedDataSchema),
  turnNotificationSchema('tool.updated', toolUpdatedDataSchema),
  turnNotificationSchema('tool.completed', toolCompletedDataSchema),
  turnNotificationSchema('approval.requested', approvalRequestedDataSchema),
  turnNotificationSchema('approval.resolved', approvalResolvedDataSchema),
  turnNotificationSchema('plan.updated', planUpdatedDataSchema),
  turnNotificationSchema('diff.updated', diffUpdatedDataSchema),
  usageNotificationSchema,
  turnNotificationSchema('agent.updated', agentUpdatedDataSchema),
  turnNotificationSchema('notice.created', noticeCreatedDataSchema),
  z.union([
    sessionNotificationSchema('extension.event', extensionEventDataSchema),
    turnNotificationSchema('extension.event', extensionEventDataSchema),
  ]),
]);

const replayResultSchema = z.strictObject({
  replayStreamId: nonEmptyStringSchema,
  events: z.array(proxyNotificationSchema),
  nextCursor: z.string().nullable(),
});

export const resultSchemas = {
  initialize: initializeResultSchema,
  'catalog.list': catalogResultSchema,
  'session.create': sessionResultSchema,
  'session.get': sessionResultSchema,
  'turn.start': acceptedTurnResultSchema,
  'turn.interrupt': z.strictObject({
    accepted: z.literal(true),
    turnId: nonEmptyStringSchema,
  }),
  'session.close': okResultSchema,
  shutdown: okResultSchema,
  'slash.list': z.strictObject({ commands: z.array(slashCommandSchema) }),
  'session.rename': okResultSchema,
  'session.native.list': z.strictObject({
    sessions: z.array(nativeSessionSummarySchema),
    nextCursor: z.string().nullable(),
  }),
  'session.replay': replayResultSchema,
  'session.config.set': z.strictObject({
    session: sessionSchema,
    configOptions: z.array(configOptionSchema),
  }),
  'turn.steer': acceptedTurnResultSchema,
  'approval.respond': z.strictObject({
    accepted: z.literal(true),
    approvalId: nonEmptyStringSchema,
  }),
} as const;

export type ManifestV2 = z.infer<typeof manifestV2Schema>;
export type InitializeParams = z.infer<typeof initializeParamsSchema>;
export type InitializeResult = z.infer<typeof initializeResultSchema>;
export type ProxyRequest = z.infer<typeof proxyRequestSchema>;
export type ProxyNotification = z.infer<typeof proxyNotificationSchema>;
export type ProxyErrorResponse = z.infer<typeof proxyErrorResponseSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type TurnStartParams = z.infer<typeof turnStartParamsSchema>;
