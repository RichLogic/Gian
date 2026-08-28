import { Buffer } from 'node:buffer';

import { z } from 'zod';

import {
  ACTIVITY_STATUSES,
  AGENT_STATES,
  CONFIG_BINDINGS,
  CONFIG_CONTROLS,
  CONTENT_FORMATS,
  CONTENT_KINDS,
  DIFF_FILE_STATUSES,
  DOMAIN_CODES,
  FILE_OPERATIONS,
  INPUT_TYPES,
  INTERACTION_ACTION_STYLES,
  INTERACTION_INPUT_TYPES,
  INTERACTION_OUTCOMES,
  JSONRPC_VERSION,
  MAX_ACTIVITY_JSON_BYTES,
  MAX_DIFF_UTF8_BYTES,
  MAX_REQUEST_JSON_BYTES,
  NATIVE_HISTORY_MODES,
  PLAN_STEP_STATUSES,
  PRESENTATION_TONES,
  PROCESS_SCOPES,
  PROTOCOL_NAME,
  PROTOCOL_V2,
  PROTOCOL_V2_LEGACY,
  REQUEST_REASONS,
  SESSION_STATES,
  STEP_STATUSES,
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
const bcp47Schema = nonEmptyStringSchema.regex(
  /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/,
  'Expected a BCP 47 language tag.',
);

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

export const wireIdSchema = nonEmptyStringSchema;

const pluginIdSchema = nonEmptyStringSchema.regex(
  /^(?:claude|codex|kimi|grok|[a-z0-9]+(?:[.-][a-z0-9]+)+)$/,
  'Expected a reserved built-in ID or reverse-domain external plugin ID.',
);
const semverSchema = nonEmptyStringSchema.regex(
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  'Expected a SemVer version.',
);

export const extensionsSchema = z.record(
  pluginIdSchema,
  z.strictObject({
    schemaVersion: positiveSafeIntegerSchema,
    payload: jsonValueSchema,
  }),
);

const manifestFields = {
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
    verifiedCliVersions: z.array(semverSchema).min(1).optional(),
    /** Legacy diagnostic field. New built-in Proxy packages use the exact
     * verified list above; retained so an older immutable package remains
     * readable during upgrade. */
    recommendedCliVersion: semverSchema.optional(),
  }).optional(),
  skills: z.array(z.strictObject({
    name: nonEmptyStringSchema,
    path: nonEmptyStringSchema
      .regex(/^[^/\\](?:.*[^/\\])?$/, 'Skill path must be relative.')
      .refine(
        value => !value.split(/[\\/]/).some(part => part === '..' || part === '.' || part === ''),
        'Skill path must stay inside the Proxy package.',
      ),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })).optional(),
};

export const manifestV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  ...manifestFields,
});

const logoAssetSchema = z.strictObject({
  path: nonEmptyStringSchema
    .regex(/^[^/\\](?:.*[^/\\])?$/, 'Logo path must be relative.')
    .refine(
      (value) => !value.split(/[\\/]/).some((part) => part === '..' || part === '.' || part === ''),
      'Logo path must stay inside the Proxy package.',
    ),
  mediaType: z.enum(['image/png', 'image/webp']),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, 'Expected a lowercase SHA-256 digest.'),
});

export const manifestV3Schema = z.strictObject({
  schemaVersion: z.literal(3),
  ...manifestFields,
  branding: z.strictObject({
    logo: z.strictObject({
      light: logoAssetSchema,
      dark: logoAssetSchema.optional(),
    }),
  }),
});

export const manifestSchema = z.discriminatedUnion('schemaVersion', [
  manifestV2Schema,
  manifestV3Schema,
]);

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
    locale: bcp47Schema.optional(),
  }),
});

export const initializeResultSchema = z.strictObject({
  protocol: z.strictObject({
    name: z.literal(PROTOCOL_NAME),
    version: z.enum([PROTOCOL_V2, PROTOCOL_V2_LEGACY]),
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

export const configValueSchema = z.union([
  z.string(),
  z.boolean(),
  z.number().finite(),
  z.null(),
]);

export const configMapSchema = z.record(nonEmptyStringSchema, configValueSchema);

const conditionSchema = z.strictObject({
  optionId: nonEmptyStringSchema,
  oneOf: z.array(configValueSchema).min(1),
});

const choiceSchema = z.strictObject({
  value: configValueSchema,
  displayName: nonEmptyStringSchema,
  description: z.string().optional(),
});

const numberConstraintsSchema = z.strictObject({
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
  step: z.number().finite().positive().optional(),
});

const textConstraintsSchema = z.strictObject({
  minimumLength: nonNegativeSafeIntegerSchema.optional(),
  maximumLength: nonNegativeSafeIntegerSchema.optional(),
  multiline: z.boolean().optional(),
});

export const configOptionSchema = z.strictObject({
  id: nonEmptyStringSchema,
  displayName: nonEmptyStringSchema,
  description: z.string().optional(),
  binding: z.enum(CONFIG_BINDINGS),
  role: nonEmptyStringSchema.optional(),
  control: z.enum(CONFIG_CONTROLS),
  required: z.boolean(),
  defaultValue: configValueSchema,
  choices: z.array(choiceSchema).optional(),
  constraints: z.union([numberConstraintsSchema, textConstraintsSchema]).optional(),
  visibleWhen: z.array(conditionSchema).optional(),
  enabledWhen: z.array(conditionSchema).optional(),
  presentation: z.strictObject({
    group: z.string().optional(),
    order: safeIntegerSchema.optional(),
    placeholder: z.string().optional(),
    sensitive: z.boolean().optional(),
  }).optional(),
}).superRefine((option, context) => {
  if (option.control === 'select' && (!option.choices || option.choices.length === 0)) {
    context.addIssue({ code: 'custom', message: 'Select options require at least one choice.' });
  }
  if (option.control !== 'select' && option.choices !== undefined) {
    context.addIssue({ code: 'custom', message: 'Only select options can provide choices.' });
  }
  if (
    option.control === 'select'
    && option.defaultValue !== null
    && !option.choices?.some((choice) => Object.is(choice.value, option.defaultValue))
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Select defaultValue must be an advertised choice.',
    });
  }
  if (option.defaultValue !== null) {
    const valid = option.control === 'boolean'
      ? typeof option.defaultValue === 'boolean'
      : option.control === 'number'
        ? typeof option.defaultValue === 'number'
        : option.control === 'text'
          ? typeof option.defaultValue === 'string'
          : true;
    if (!valid) {
      context.addIssue({
        code: 'custom',
        message: `defaultValue does not match ${option.control}.`,
      });
    }
  }
  if (option.constraints !== undefined) {
    const numberKeys = ['minimum', 'maximum', 'step'] as const;
    const textKeys = ['minimumLength', 'maximumLength', 'multiline'] as const;
    const hasNumber = numberKeys.some((key) => key in option.constraints!);
    const hasText = textKeys.some((key) => key in option.constraints!);
    if (option.control === 'number') {
      if (hasText) {
        context.addIssue({
          code: 'custom',
          message: 'Number options cannot carry text constraints.',
        });
      }
    } else if (option.control === 'text') {
      if (hasNumber) {
        context.addIssue({
          code: 'custom',
          message: 'Text options cannot carry number constraints.',
        });
      }
    } else if (hasNumber || hasText) {
      context.addIssue({
        code: 'custom',
        message: `${option.control} options cannot carry constraints.`,
      });
    }
  }
});

const inputDescriptorSchema = z.strictObject({
  type: z.enum(INPUT_TYPES),
  enabledWhen: z.array(conditionSchema).optional(),
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

export const catalogActionDescriptorSchema = z.strictObject({
  id: nonEmptyStringSchema,
  supported: z.boolean(),
  reason: z.string().optional(),
});

export const availableActionSchema = z.strictObject({
  enabled: z.boolean(),
  reason: z.string().optional(),
});

export const availableActionsSchema = z.record(nonEmptyStringSchema, availableActionSchema);

export const specialCatalogsSchema = z.strictObject({
  model: nonEmptyStringSchema.optional(),
  thinking: nonEmptyStringSchema.optional(),
  fast: nonEmptyStringSchema.optional(),
  approvalMode: nonEmptyStringSchema.optional(),
}).superRefine((value, context) => {
  const ids = Object.values(value).filter((id): id is string => id !== undefined);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', message: 'Special Catalog option ids must be unique.' });
  }
});

export const catalogResultSchema = z.strictObject({
  catalogRevision: nonEmptyStringSchema,
  input: z.array(inputDescriptorSchema),
  configOptions: z.array(configOptionSchema),
  specialCatalogs: specialCatalogsSchema.optional(),
  actions: z.array(catalogActionDescriptorSchema).optional(),
  slashCommands: z.array(slashCommandSchema),
});

export const catalogResolveParamsSchema = z.strictObject({
  catalogRevision: nonEmptyStringSchema,
  sessionId: nonEmptyStringSchema.optional(),
  streamId: nonEmptyStringSchema.optional(),
  sessionConfig: configMapSchema,
  turnConfig: configMapSchema,
}).superRefine((value, context) => {
  if ((value.sessionId === undefined) !== (value.streamId === undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'sessionId and streamId must both be present or both omitted.',
    });
  }
});

export const catalogResolveResultSchema = catalogResultSchema.extend({
  resolvedDefaults: z.strictObject({
    sessionConfig: configMapSchema,
    turnConfig: configMapSchema,
  }),
});

const httpUrlSchema = nonEmptyStringSchema.refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}, 'Expected an absolute HTTP(S) URL.');

export const hostServiceDescriptorSchema = z.strictObject({
  id: nonEmptyStringSchema,
  protocol: z.literal('mcp'),
  transport: z.strictObject({
    type: z.literal('streamable-http'),
    url: httpUrlSchema,
    headers: z.record(nonEmptyStringSchema, z.string()).optional(),
  }),
});
export type HostServiceDescriptor = z.infer<typeof hostServiceDescriptorSchema>;

const nativeSessionRefSchema = z.strictObject({
  id: nonEmptyStringSchema,
  history: z.enum(NATIVE_HISTORY_MODES).optional(),
});

const turnConfigFields = {
  turnConfigOptions: z.array(configOptionSchema).optional(),
  turnConfigRevision: nonEmptyStringSchema.optional(),
};

function refineTurnConfigPair(
  value: { turnConfigOptions?: unknown; turnConfigRevision?: unknown },
  context: z.RefinementCtx,
): void {
  const hasOptions = value.turnConfigOptions !== undefined;
  const hasRevision = value.turnConfigRevision !== undefined;
  if (hasOptions !== hasRevision) {
    context.addIssue({
      code: 'custom',
      message: 'turnConfigOptions and turnConfigRevision must be sent together.',
    });
  }
}

export const sessionSchema = z.strictObject({
  id: nonEmptyStringSchema,
  nativeSession: z.strictObject({ id: nonEmptyStringSchema }).optional(),
  streamId: nonEmptyStringSchema,
  state: z.enum(SESSION_STATES),
  sessionConfig: configMapSchema,
  lastError: z.string().nullable().optional(),
  availableActions: availableActionsSchema.optional(),
  ...turnConfigFields,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).superRefine(refineTurnConfigPair);

export const resumeRefSchema = z.strictObject({
  id: nonEmptyStringSchema,
});

export const sidechatAnchorSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('empty') }),
  z.strictObject({
    type: z.literal('turn'),
    turnId: nonEmptyStringSchema,
    sourceTurnId: nonEmptyStringSchema,
  }),
  z.strictObject({
    type: z.literal('activeInput'),
    turnId: nonEmptyStringSchema,
    sourceTurnId: nonEmptyStringSchema,
  }),
]);

export const sidechatSchema = z.strictObject({
  id: nonEmptyStringSchema,
  parentSessionId: nonEmptyStringSchema,
  streamId: nonEmptyStringSchema,
  state: z.enum(SESSION_STATES),
  resumeRef: resumeRefSchema,
  anchor: sidechatAnchorSchema,
  sessionConfig: configMapSchema,
  lastError: z.string().nullable().optional(),
  ...turnConfigFields,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).superRefine(refineTurnConfigPair);

export const sidechatCreateParamsSchema = z.strictObject({
  parentSessionId: nonEmptyStringSchema,
  parentStreamId: nonEmptyStringSchema,
  sidechatId: nonEmptyStringSchema,
});

export const sidechatResumeParamsSchema = z.strictObject({
  sidechatId: nonEmptyStringSchema,
  parentSessionId: nonEmptyStringSchema,
  resumeRef: resumeRefSchema,
});

export const sidechatCloseParamsSchema = z.strictObject({
  sidechatId: nonEmptyStringSchema,
  streamId: nonEmptyStringSchema.optional(),
  resumeRef: resumeRefSchema,
});

export const sidechatResultSchema = z.strictObject({
  sidechat: sidechatSchema,
});

export const sidechatCloseResultSchema = z.strictObject({
  ok: z.literal(true),
  sidechatId: nonEmptyStringSchema,
  providerDataDeleted: z.boolean(),
});

export const forkAnchorSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('head') }),
  z.strictObject({
    type: z.literal('turn'),
    turnId: nonEmptyStringSchema,
    sourceTurnId: nonEmptyStringSchema,
  }),
]);

export const forkOriginSchema = z.strictObject({
  kind: z.literal('fork'),
  sessionId: nonEmptyStringSchema,
  turnId: nonEmptyStringSchema,
  sourceTurnId: nonEmptyStringSchema,
});

export const sessionForkParamsSchema = z.strictObject({
  sourceSessionId: nonEmptyStringSchema,
  sourceStreamId: nonEmptyStringSchema,
  sessionId: nonEmptyStringSchema,
  anchor: forkAnchorSchema,
  hostServices: z.array(hostServiceDescriptorSchema).optional(),
});

export const sessionForkResultSchema = z.strictObject({
  session: sessionSchema,
  origin: forkOriginSchema,
}).superRefine((value, ctx) => {
  if (!value.session.nativeSession?.id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'session.fork Result requires durable nativeSession.id',
      path: ['session', 'nativeSession'],
    });
  }
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
  workspace: z.strictObject({
    cwd: nonEmptyStringSchema,
    roots: z.array(nonEmptyStringSchema).min(1),
  }),
  nativeSession: nativeSessionRefSchema.optional(),
  forkBoundaries: z.array(z.strictObject({
    turnId: nonEmptyStringSchema,
    sourceTurnId: nonEmptyStringSchema,
  })).max(10_000).optional(),
  config: configMapSchema,
  hostServices: z.array(hostServiceDescriptorSchema).optional(),
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
  config: configMapSchema,
});

const interruptParamsSchema = sessionAndStreamSchema.extend({
  turnId: nonEmptyStringSchema,
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

const interactionValueSchema = z.union([
  z.string(),
  z.boolean(),
  z.array(z.string()),
]);

const interactionRespondParamsSchema = interruptParamsSchema.extend({
  responseId: nonEmptyStringSchema,
  interactionId: nonEmptyStringSchema,
  actionId: nonEmptyStringSchema,
  values: z.record(nonEmptyStringSchema, interactionValueSchema),
});

const emptyParamsSchema = z.strictObject({});

function requestSchema<M extends string, S extends z.ZodType>(
  method: M,
  params: S,
) {
  return z.strictObject({
    jsonrpc: z.literal(JSONRPC_VERSION),
    id: wireIdSchema,
    method: z.literal(method),
    params,
    extensions: extensionsSchema.optional(),
  });
}

export const proxyRequestSchema = z.discriminatedUnion('method', [
  requestSchema('initialize', initializeParamsSchema),
  requestSchema('catalog.list', emptyParamsSchema),
  requestSchema('catalog.resolve', catalogResolveParamsSchema),
  requestSchema('session.create', sessionCreateParamsSchema),
  requestSchema('session.get', z.strictObject({ sessionId: nonEmptyStringSchema })),
  requestSchema('turn.start', turnStartParamsSchema),
  requestSchema('turn.interrupt', interruptParamsSchema),
  requestSchema('session.close', sessionAndStreamSchema),
  requestSchema('shutdown', emptyParamsSchema),
  requestSchema('session.rename', sessionAndStreamSchema.extend({
    name: z.string().refine(
      (value) => [...value].length <= 200,
      'Session name must not exceed 200 Unicode code points.',
    ),
  })),
  requestSchema('session.native.list', nativeSessionListParamsSchema),
  requestSchema('session.native.delete', z.strictObject({
    nativeSessionId: nonEmptyStringSchema,
  })),
  requestSchema('session.replay', sessionAndStreamSchema.extend({
    cursor: z.string().nullable(),
    limit: positiveSafeIntegerSchema.max(500),
  })),
  requestSchema('turn.steer', interruptParamsSchema.extend({
    input: z.array(inputItemSchema).min(1),
  })),
  requestSchema('interaction.respond', interactionRespondParamsSchema),
  requestSchema('sidechat.create', sidechatCreateParamsSchema),
  requestSchema('sidechat.resume', sidechatResumeParamsSchema),
  requestSchema('sidechat.close', sidechatCloseParamsSchema),
  requestSchema('session.fork', sessionForkParamsSchema),
]);

export const runtimeErrorSchema = z.strictObject({
  domainCode: z.enum(DOMAIN_CODES),
  message: nonEmptyStringSchema,
  retryable: z.boolean(),
  details: z.record(z.string(), jsonValueSchema),
});

export const jsonRpcErrorObjectSchema = z.strictObject({
  code: safeIntegerSchema,
  message: nonEmptyStringSchema,
  data: jsonValueSchema.optional(),
});

export const proxyErrorResponseSchema = z.strictObject({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: z.union([wireIdSchema, z.null()]),
  error: jsonRpcErrorObjectSchema,
  extensions: extensionsSchema.optional(),
});

export const proxySuccessResponseEnvelopeSchema = z.strictObject({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: wireIdSchema,
  result: z.unknown(),
  extensions: extensionsSchema.optional(),
});

const okResultSchema = z.strictObject({ ok: z.literal(true) });
const sessionResultSchema = z.strictObject({ session: sessionSchema });
const acceptedTurnResultSchema = z.strictObject({
  accepted: z.literal(true),
  turnId: nonEmptyStringSchema,
});

const contentKindSchema = z.enum(CONTENT_KINDS);
const toneSchema = z.enum(PRESENTATION_TONES);

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
  sourceTurnId: nonEmptyStringSchema,
};

function sessionNotificationSchema<M extends string, S extends z.ZodType>(
  method: M,
  data: S,
) {
  return z.strictObject({
    jsonrpc: z.literal(JSONRPC_VERSION),
    method: z.literal(method),
    params: z.strictObject({
      ...sessionEventFields,
      data,
    }),
    extensions: extensionsSchema.optional(),
  });
}

function turnNotificationSchema<M extends string, S extends z.ZodType>(
  method: M,
  data: S,
) {
  return z.strictObject({
    jsonrpc: z.literal(JSONRPC_VERSION),
    method: z.literal(method),
    params: z.strictObject({
      ...turnEventFields,
      data,
    }),
    extensions: extensionsSchema.optional(),
  });
}

function processNotificationSchema<M extends string, S extends z.ZodType>(
  method: M,
  data: S,
) {
  return z.strictObject({
    jsonrpc: z.literal(JSONRPC_VERSION),
    method: z.literal(method),
    params: z.strictObject({
      eventId: nonEmptyStringSchema,
      emittedAt: isoDateTimeSchema,
      data,
    }),
    extensions: extensionsSchema.optional(),
  });
}

const sessionUpdatedDataSchema = z.strictObject({
  nativeSession: z.strictObject({ id: nonEmptyStringSchema }).optional(),
  state: z.enum(SESSION_STATES).optional(),
  lastError: z.string().nullable().optional(),
  availableActions: availableActionsSchema.optional(),
  ...turnConfigFields,
  updatedAt: isoDateTimeSchema.optional(),
}).superRefine((value, context) => {
  refineTurnConfigPair(value, context);
  if (Object.keys(value).length === 0) {
    context.addIssue({
      code: 'custom',
      message: 'session.updated must contain at least one changed field.',
    });
  }
});

function refineContentFormat(
  value: { kind: string; format?: string },
  context: z.RefinementCtx,
): void {
  if (value.format !== undefined && value.kind !== 'text') {
    context.addIssue({
      code: 'custom',
      message: 'format is only valid for text content.',
    });
  }
}

const contentDeltaDataSchema = z.strictObject({
  contentId: nonEmptyStringSchema,
  kind: contentKindSchema,
  format: z.enum(CONTENT_FORMATS).optional(),
  stepId: nonEmptyStringSchema.optional(),
  delta: z.string(),
}).superRefine(refineContentFormat);

const contentCompletedDataSchema = z.strictObject({
  contentId: nonEmptyStringSchema,
  kind: contentKindSchema,
  format: z.enum(CONTENT_FORMATS).optional(),
  stepId: nonEmptyStringSchema.optional(),
  content: z.string().optional(),
}).superRefine(refineContentFormat);

const inputRecordedDataSchema = z.strictObject({
  input: z.array(inputItemSchema).min(1),
});

function boundedJsonField(
  value: unknown,
  field: string,
  context: z.RefinementCtx,
  maxBytes = MAX_ACTIVITY_JSON_BYTES,
): void {
  if (value === undefined) return;
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > maxBytes) {
    context.addIssue({
      code: 'custom',
      message: `${field} exceeds ${maxBytes} bytes.`,
    });
  }
}

const activityPresentationSchema = z.strictObject({
  type: nonEmptyStringSchema,
  tone: toneSchema.optional(),
  data: jsonValueSchema.optional(),
}).superRefine((value, context) => {
  boundedJsonField(value.data, 'presentation.data', context);
  const data = value.data;
  const asRecord = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : null;
  const requireString = (key: string) => {
    if (asRecord === null || typeof asRecord[key] !== 'string' || asRecord[key] === '') {
      context.addIssue({
        code: 'custom',
        message: `presentation.data.${key} is required for type ${value.type}.`,
      });
    }
  };
  switch (value.type) {
    case 'generic':
      return;
    case 'tool':
      requireString('name');
      return;
    case 'command':
      requireString('command');
      return;
    case 'search':
      requireString('query');
      return;
    case 'file':
      requireString('path');
      if (
        asRecord === null
        || typeof asRecord.operation !== 'string'
        || !FILE_OPERATIONS.includes(asRecord.operation as typeof FILE_OPERATIONS[number])
      ) {
        context.addIssue({
          code: 'custom',
          message: 'presentation.data.operation must be read, write, delete, or rename.',
        });
      }
      return;
    case 'agent':
      requireString('agentId');
      if (
        asRecord === null
        || typeof asRecord.state !== 'string'
        || !AGENT_STATES.includes(asRecord.state as typeof AGENT_STATES[number])
      ) {
        context.addIssue({
          code: 'custom',
          message: 'presentation.data.state must be running, completed, failed, or interrupted.',
        });
      }
      return;
    case 'notice':
      requireString('message');
      return;
    default:
      return;
  }
});

const activityUpdatedDataSchema = z.strictObject({
  activityId: nonEmptyStringSchema,
  kind: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  status: z.enum(ACTIVITY_STATUSES),
  stepId: nonEmptyStringSchema.optional(),
  summary: z.string().optional(),
  presentation: activityPresentationSchema,
  details: jsonValueSchema.optional(),
}).superRefine((value, context) => {
  boundedJsonField(value.details, 'details', context);
});

const interactionChoiceSchema = z.strictObject({
  value: z.string(),
  displayName: nonEmptyStringSchema,
});

const interactionInputSchema = z.strictObject({
  id: nonEmptyStringSchema,
  type: z.enum(INTERACTION_INPUT_TYPES),
  label: nonEmptyStringSchema,
  required: z.boolean(),
  description: z.string().optional(),
  choices: z.array(interactionChoiceSchema).optional(),
  sensitive: z.boolean().optional(),
  minimumLength: nonNegativeSafeIntegerSchema.optional(),
  maximumLength: nonNegativeSafeIntegerSchema.optional(),
  multiline: z.boolean().optional(),
  placeholder: z.string().optional(),
}).superRefine((value, context) => {
  const select = value.type === 'single_select' || value.type === 'multi_select';
  if (select && (!value.choices || value.choices.length === 0)) {
    context.addIssue({
      code: 'custom',
      message: 'Select interaction inputs require at least one choice.',
    });
  }
  if (!select && value.choices !== undefined) {
    context.addIssue({
      code: 'custom',
      message: 'Only select interaction inputs can provide choices.',
    });
  }
});

const interactionActionSchema = z.strictObject({
  id: nonEmptyStringSchema,
  label: nonEmptyStringSchema,
  style: z.enum(INTERACTION_ACTION_STYLES),
});

const interactionRequestedDataSchema = z.strictObject({
  interactionId: nonEmptyStringSchema,
  title: z.string().optional(),
  description: z.string().optional(),
  presentation: z.strictObject({
    kind: nonEmptyStringSchema,
    tone: toneSchema.optional(),
  }),
  inputs: z.array(interactionInputSchema),
  actions: z.array(interactionActionSchema).min(1),
  context: z.record(z.string(), jsonValueSchema).optional(),
});

const interactionResolvedDataSchema = z.strictObject({
  interactionId: nonEmptyStringSchema,
  outcome: z.enum(INTERACTION_OUTCOMES),
  actionId: nonEmptyStringSchema.optional(),
  displaySummary: z.string().optional(),
}).superRefine((value, context) => {
  if (value.outcome === 'submitted' && value.actionId === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'submitted interactions require actionId.',
    });
  }
  if (value.outcome !== 'submitted' && value.actionId !== undefined) {
    context.addIssue({
      code: 'custom',
      message: 'Only submitted interactions can include actionId.',
    });
  }
});

const planUpdatedDataSchema = z.strictObject({
  planId: nonEmptyStringSchema,
  title: z.string(),
  steps: z.array(z.strictObject({
    id: nonEmptyStringSchema,
    text: nonEmptyStringSchema,
    status: z.enum(PLAN_STEP_STATUSES),
  })),
});

const localFileArtifactSchema = z.strictObject({
  type: z.literal('localFile'),
  path: nonEmptyStringSchema,
  name: z.string().optional(),
  mime: z.string().optional(),
  size: nonNegativeSafeIntegerSchema.optional(),
});

export const stepUpdatedDataSchema = z.strictObject({
  stepId: nonEmptyStringSchema,
  index: nonNegativeSafeIntegerSchema,
  status: z.enum(STEP_STATUSES),
});

export const requestUpdatedDataSchema = z.strictObject({
  requestId: nonEmptyStringSchema,
  reason: z.enum(REQUEST_REASONS),
  stepId: nonEmptyStringSchema.optional(),
  model: z.strictObject({
    provider: z.string().optional(),
    id: nonEmptyStringSchema,
    displayName: z.string().optional(),
  }).optional(),
  parameters: configMapSchema.optional(),
  systemPrompt: z.strictObject({
    text: z.string(),
    truncated: z.boolean(),
  }).optional(),
  tools: z.array(z.strictObject({
    name: nonEmptyStringSchema,
    description: z.string().optional(),
  })).optional(),
  context: z.strictObject({
    window: positiveSafeIntegerSchema.optional(),
  }).optional(),
  truncated: z.boolean().optional(),
  artifact: localFileArtifactSchema.optional(),
}).superRefine((value, context) => {
  boundedJsonField(value, 'request.updated data', context, MAX_REQUEST_JSON_BYTES);
});

const diffUpdatedDataSchema = z.strictObject({
  diffId: nonEmptyStringSchema,
  diff: z.string(),
  truncated: z.boolean(),
  files: z.array(z.strictObject({
    path: nonEmptyStringSchema,
    status: z.enum(DIFF_FILE_STATUSES),
  })).optional(),
  artifact: localFileArtifactSchema.optional(),
}).superRefine((value, context) => {
  if (Buffer.byteLength(value.diff, 'utf8') > MAX_DIFF_UTF8_BYTES) {
    context.addIssue({
      code: 'custom',
      message: `diff exceeds ${MAX_DIFF_UTF8_BYTES} bytes.`,
    });
  }
});

export const usageDataSchema = z.strictObject({
  stepId: nonEmptyStringSchema.optional(),
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
}).refine(
  (value) => value.context !== undefined || value.conversation !== undefined,
  'usage.updated must change at least one usage field.',
);

const invalidationDataSchema = z.strictObject({
  reason: nonEmptyStringSchema,
  revision: nonEmptyStringSchema.optional(),
});

const sessionRuntimeErrorSchema = sessionNotificationSchema(
  'runtime.error',
  runtimeErrorSchema,
);
const processRuntimeErrorSchema = processNotificationSchema(
  'runtime.error',
  runtimeErrorSchema,
);

const usageNotificationSchema = z.union([
  sessionNotificationSchema('usage.updated', usageDataSchema),
  turnNotificationSchema('usage.updated', usageDataSchema),
]).superRefine((value, context) => {
  const conversation = value.params.data.conversation;
  if (conversation?.mode === 'delta' && !('turnId' in value.params)) {
    context.addIssue({
      code: 'custom',
      message: 'Delta conversation usage requires turnId and sourceTurnId.',
    });
  }
  if (value.params.data.stepId !== undefined && !('turnId' in value.params)) {
    context.addIssue({
      code: 'custom',
      message: 'stepId is valid only on Turn-scoped usage.updated.',
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
    error: runtimeErrorSchema,
  })),
  sessionRuntimeErrorSchema,
  processRuntimeErrorSchema,
  turnNotificationSchema('activity.updated', activityUpdatedDataSchema),
  turnNotificationSchema('step.updated', stepUpdatedDataSchema),
  turnNotificationSchema('request.updated', requestUpdatedDataSchema),
  turnNotificationSchema('interaction.requested', interactionRequestedDataSchema),
  turnNotificationSchema('interaction.resolved', interactionResolvedDataSchema),
  turnNotificationSchema('plan.updated', planUpdatedDataSchema),
  turnNotificationSchema('diff.updated', diffUpdatedDataSchema),
  usageNotificationSchema,
  processNotificationSchema('catalog.changed', invalidationDataSchema),
  sessionNotificationSchema('history.changed', invalidationDataSchema),
]);

function replayEventSchema<M extends string, S extends z.ZodType>(
  method: M,
  data: S,
) {
  return z.strictObject({
    method: z.literal(method),
    eventId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    replayStreamId: nonEmptyStringSchema,
    sequence: positiveSafeIntegerSchema,
    sourceTurnId: nonEmptyStringSchema,
    emittedAt: isoDateTimeSchema,
    data,
    extensions: extensionsSchema.optional(),
  });
}

export const replayEventSchemaUnion = z.union([
  replayEventSchema('turn.started', z.strictObject({})),
  replayEventSchema('input.recorded', inputRecordedDataSchema),
  replayEventSchema('content.delta', contentDeltaDataSchema),
  replayEventSchema('content.completed', contentCompletedDataSchema),
  replayEventSchema('turn.completed', z.strictObject({
    stopReason: z.enum(STOP_REASONS),
  })),
  replayEventSchema('turn.failed', z.strictObject({
    error: runtimeErrorSchema,
  })),
  replayEventSchema('activity.updated', activityUpdatedDataSchema),
  replayEventSchema('step.updated', stepUpdatedDataSchema),
  replayEventSchema('request.updated', requestUpdatedDataSchema),
  replayEventSchema('interaction.requested', interactionRequestedDataSchema),
  replayEventSchema('interaction.resolved', interactionResolvedDataSchema),
  replayEventSchema('plan.updated', planUpdatedDataSchema),
  replayEventSchema('diff.updated', diffUpdatedDataSchema),
  replayEventSchema('usage.updated', usageDataSchema),
]);

const replayResultSchema = z.strictObject({
  replayStreamId: nonEmptyStringSchema,
  events: z.array(replayEventSchemaUnion),
  nextCursor: z.string().nullable(),
});

export const resultSchemas = {
  initialize: initializeResultSchema,
  'catalog.list': catalogResultSchema,
  'catalog.resolve': catalogResolveResultSchema,
  'session.create': sessionResultSchema,
  'session.get': sessionResultSchema,
  'turn.start': acceptedTurnResultSchema,
  'turn.interrupt': z.strictObject({
    accepted: z.literal(true),
    turnId: nonEmptyStringSchema,
  }),
  'session.close': okResultSchema,
  shutdown: okResultSchema,
  'session.rename': okResultSchema,
  'session.native.list': z.strictObject({
    sessions: z.array(nativeSessionSummarySchema),
    nextCursor: z.string().nullable(),
  }),
  'session.native.delete': okResultSchema,
  'session.replay': replayResultSchema,
  'turn.steer': acceptedTurnResultSchema,
  'interaction.respond': z.strictObject({
    accepted: z.literal(true),
    interactionId: nonEmptyStringSchema,
    responseId: nonEmptyStringSchema,
  }),
  'sidechat.create': sidechatResultSchema,
  'sidechat.resume': sidechatResultSchema,
  'sidechat.close': sidechatCloseResultSchema,
  'session.fork': sessionForkResultSchema,
} as const;

export type ManifestV2 = z.infer<typeof manifestV2Schema>;
export type ManifestV3 = z.infer<typeof manifestV3Schema>;
export type ProxyManifest = z.infer<typeof manifestSchema>;
export type InitializeParams = z.infer<typeof initializeParamsSchema>;
export type InitializeResult = z.infer<typeof initializeResultSchema>;
export type ProxyRequest = z.infer<typeof proxyRequestSchema>;
export type ProxyNotification = z.infer<typeof proxyNotificationSchema>;
export type ProxyErrorResponse = z.infer<typeof proxyErrorResponseSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type TurnStartParams = z.infer<typeof turnStartParamsSchema>;
export type ConfigOption = z.infer<typeof configOptionSchema>;
export type ConfigValue = z.infer<typeof configValueSchema>;
export type ReplayEvent = z.infer<typeof replayEventSchemaUnion>;
export type CatalogResult = z.infer<typeof catalogResultSchema>;
export type SpecialCatalogs = z.infer<typeof specialCatalogsSchema>;
export type CatalogActionDescriptor = z.infer<typeof catalogActionDescriptorSchema>;
export type AvailableActions = z.infer<typeof availableActionsSchema>;
export type ResumeRef = z.infer<typeof resumeRefSchema>;
export type SidechatAnchor = z.infer<typeof sidechatAnchorSchema>;
export type SideChatSnapshot = z.infer<typeof sidechatSchema>;
export type ForkAnchor = z.infer<typeof forkAnchorSchema>;
export type ForkOrigin = z.infer<typeof forkOriginSchema>;
export type SidechatCloseResult = z.infer<typeof sidechatCloseResultSchema>;
export type SessionForkResult = z.infer<typeof sessionForkResultSchema>;
