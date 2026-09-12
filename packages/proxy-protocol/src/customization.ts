import { Buffer } from 'node:buffer';
import { isAbsolute } from 'node:path';

import { z } from 'zod';

import {
  CUSTOMIZATION_ACTIVATIONS,
  CUSTOMIZATION_DETAIL_STATUSES,
  CUSTOMIZATION_DIAGNOSTIC_CODES,
  CUSTOMIZATION_DISCOVERY_METHODS,
  CUSTOMIZATION_KINDS,
  CUSTOMIZATION_LIST_STATUSES,
  CUSTOMIZATION_MCP_TRANSPORTS,
  CUSTOMIZATION_ORIGIN_KINDS,
  CUSTOMIZATION_SCOPE_LEVELS,
  CUSTOMIZATION_SKILL_FORMATS,
  CUSTOMIZATION_STABLE_ID_HEX_CHARS,
  CUSTOMIZATION_STABLE_ID_PREFIX,
  INVENTORY_COMPLETENESS,
  MAX_CUSTOMIZATION_DETAIL_UTF8_BYTES,
  MAX_CUSTOMIZATION_DIAGNOSTICS,
  MAX_CUSTOMIZATION_ITEMS,
  MAX_CUSTOMIZATION_NAME_UTF8_BYTES,
  MAX_CUSTOMIZATION_PATH_UTF8_BYTES,
  MAX_CUSTOMIZATION_TEXT_UTF8_BYTES,
  MAX_CUSTOMIZATION_WARNINGS,
  RULE_EFFECT_STATUSES,
} from './constants.js';

const isoDateTimeSchema = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)),
  'Expected an ISO-8601 timestamp.',
);

function utf8BytesAtMost(value: unknown, field: string, maxBytes: number, ctx: z.RefinementCtx): void {
  if (typeof value !== 'string') return;
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maxBytes) {
    ctx.addIssue({ code: 'custom', message: `${field} exceeds ${maxBytes} UTF-8 bytes.` });
  }
}

function boundedStringSchema(maxBytes: number) {
  return z.string().superRefine((value, ctx) => utf8BytesAtMost(value, 'field', maxBytes, ctx));
}

export const customizationItemIdSchema = z.string().regex(
  new RegExp(`^${CUSTOMIZATION_STABLE_ID_PREFIX}[a-f0-9]{${CUSTOMIZATION_STABLE_ID_HEX_CHARS}}$`),
  `Customization ids must match ${CUSTOMIZATION_STABLE_ID_PREFIX}<${CUSTOMIZATION_STABLE_ID_HEX_CHARS} lowercase hex>.`,
);

const diagnosticsSchema = z.array(z.strictObject({
  code: z.enum(CUSTOMIZATION_DIAGNOSTIC_CODES),
  message: boundedStringSchema(MAX_CUSTOMIZATION_TEXT_UTF8_BYTES),
})).max(MAX_CUSTOMIZATION_DIAGNOSTICS);

const warningsSchema = z.array(z.strictObject({
  code: z.enum(CUSTOMIZATION_DIAGNOSTIC_CODES),
  message: boundedStringSchema(MAX_CUSTOMIZATION_TEXT_UTF8_BYTES),
})).max(MAX_CUSTOMIZATION_WARNINGS);

const absolutePathSchema = z.string().refine(
  (value) => isAbsolute(value),
  'cwd must be an absolute path.',
);

export const customizationListParamsSchema = z.strictObject({
  kind: z.enum(CUSTOMIZATION_KINDS),
  /** Host-resolved absolute path of the registered Workspace root. Omitted
   *  lists non-Workspace (user/global) scope only. */
  cwd: absolutePathSchema.optional(),
});

export const customizationDetailParamsSchema = z.strictObject({
  kind: z.enum(CUSTOMIZATION_KINDS),
  id: customizationItemIdSchema,
  cwd: absolutePathSchema.optional(),
});

const customizationItemBaseSchema = z.strictObject({
  id: customizationItemIdSchema,
  kind: z.enum(CUSTOMIZATION_KINDS),
  name: boundedStringSchema(MAX_CUSTOMIZATION_NAME_UTF8_BYTES),
  description: boundedStringSchema(MAX_CUSTOMIZATION_TEXT_UTF8_BYTES).optional(),
  /** Opaque Provider-native type label. Host/Web never interpret it. */
  nativeType: boundedStringSchema(MAX_CUSTOMIZATION_NAME_UTF8_BYTES).optional(),
  /** Opaque Provider-native lifecycle/status label. */
  nativeStatus: boundedStringSchema(MAX_CUSTOMIZATION_NAME_UTF8_BYTES).optional(),
  activation: z.enum(CUSTOMIZATION_ACTIVATIONS),
  scope: z.strictObject({
    level: z.enum(CUSTOMIZATION_SCOPE_LEVELS),
    root: boundedStringSchema(MAX_CUSTOMIZATION_PATH_UTF8_BYTES).optional(),
    native: boundedStringSchema(MAX_CUSTOMIZATION_NAME_UTF8_BYTES).optional(),
  }),
  origin: z.strictObject({
    kind: z.enum(CUSTOMIZATION_ORIGIN_KINDS),
    path: boundedStringSchema(MAX_CUSTOMIZATION_PATH_UTF8_BYTES).optional(),
    label: boundedStringSchema(MAX_CUSTOMIZATION_NAME_UTF8_BYTES).optional(),
  }),
  discovery: z.strictObject({
    method: z.enum(CUSTOMIZATION_DISCOVERY_METHODS),
  }),
  warnings: warningsSchema.optional(),
});

const skillCustomizationItemSchema = customizationItemBaseSchema.extend({
  kind: z.literal('skill'),
  skill: z.strictObject({
    format: z.enum(CUSTOMIZATION_SKILL_FORMATS),
    entryPath: boundedStringSchema(MAX_CUSTOMIZATION_PATH_UTF8_BYTES).optional(),
    invocation: boundedStringSchema(MAX_CUSTOMIZATION_NAME_UTF8_BYTES).optional(),
    userInvocable: z.boolean().nullable(),
    modelInvocable: z.boolean().nullable(),
  }),
});

const mcpCustomizationItemSchema = customizationItemBaseSchema.extend({
  kind: z.literal('mcp'),
  mcp: z.strictObject({
    transport: z.enum(CUSTOMIZATION_MCP_TRANSPORTS),
    /** Redacted transport target (command basename or URL origin without
     *  query/fragment). Must never carry secrets. */
    targetSummary: boundedStringSchema(MAX_CUSTOMIZATION_PATH_UTF8_BYTES).optional(),
    /** Provider-reported tool count only; Host never connects to verify. */
    toolCount: z.number().int().min(0).optional(),
  }),
});

const hookCustomizationItemSchema = customizationItemBaseSchema.extend({
  kind: z.literal('hook'),
  hook: z.strictObject({
    nativeEvent: boundedStringSchema(MAX_CUSTOMIZATION_NAME_UTF8_BYTES),
    matcher: boundedStringSchema(MAX_CUSTOMIZATION_NAME_UTF8_BYTES).optional(),
    handler: z.strictObject({
      nativeType: boundedStringSchema(MAX_CUSTOMIZATION_NAME_UTF8_BYTES),
      targetSummary: boundedStringSchema(MAX_CUSTOMIZATION_TEXT_UTF8_BYTES),
    }),
    timeoutMs: z.number().int().positive().optional(),
  }),
});

export const ruleCustomizationItemSchema = customizationItemBaseSchema.extend({
  kind: z.literal('rule'),
  rule: z.strictObject({
    /** Directory the rule applies under when scope.level is `directory`. */
    appliesTo: boundedStringSchema(MAX_CUSTOMIZATION_PATH_UTF8_BYTES).optional(),
    lineCount: z.number().int().min(0).optional(),
    truncated: z.boolean(),
    /** Facts only; UI wording is owned by the Web layer. */
    status: z.enum(RULE_EFFECT_STATUSES),
  }),
});

export const customizationItemSchema = z.discriminatedUnion('kind', [
  skillCustomizationItemSchema,
  mcpCustomizationItemSchema,
  hookCustomizationItemSchema,
  ruleCustomizationItemSchema,
]);

export const customizationListResultSchema = z.strictObject({
  kind: z.enum(CUSTOMIZATION_KINDS),
  status: z.enum(CUSTOMIZATION_LIST_STATUSES),
  completeness: z.enum(INVENTORY_COMPLETENESS),
  observedAt: isoDateTimeSchema,
  items: z.array(customizationItemSchema).max(MAX_CUSTOMIZATION_ITEMS),
  truncated: z.boolean(),
  diagnostics: diagnosticsSchema,
}).superRefine((result, ctx) => {
  // Status/completeness invariants: an empty array must mean a genuinely
  // empty inventory within the declared completeness, never a failure.
  // `ok+none` is forbidden: an ok result must assert at least configured.
  if (result.status !== 'ok' && result.items.length > 0) {
    ctx.addIssue({
      code: 'custom',
      message: 'Non-ok statuses must return empty items.',
      path: ['items'],
    });
  }
  if (result.status !== 'ok' && result.completeness !== 'none') {
    ctx.addIssue({
      code: 'custom',
      message: 'Non-ok statuses must use completeness none.',
      path: ['completeness'],
    });
  }
  if (result.status === 'ok' && result.completeness === 'none') {
    ctx.addIssue({
      code: 'custom',
      message: 'status ok must carry effective, configured, or partial completeness.',
      path: ['completeness'],
    });
  }
  if (result.truncated && !(result.status === 'ok' && result.completeness === 'partial')) {
    ctx.addIssue({
      code: 'custom',
      message: 'truncated requires status ok with completeness partial.',
      path: ['truncated'],
    });
  }
  const seen = new Set<string>();
  for (const item of result.items) {
    if (item.kind !== result.kind) {
      ctx.addIssue({
        code: 'custom',
        message: `Item kind ${item.kind} does not match result kind ${result.kind}.`,
        path: ['items'],
      });
    }
    if (seen.has(item.id)) {
      ctx.addIssue({ code: 'custom', message: `Duplicate item id ${item.id}.`, path: ['items'] });
    }
    seen.add(item.id);
  }
});

export const customizationDetailResultSchema = z.strictObject({
  kind: z.enum(CUSTOMIZATION_KINDS),
  id: customizationItemIdSchema,
  status: z.enum(CUSTOMIZATION_DETAIL_STATUSES),
  observedAt: isoDateTimeSchema,
  text: z.string().superRefine((value, ctx) => (
    utf8BytesAtMost(value, 'text', MAX_CUSTOMIZATION_DETAIL_UTF8_BYTES, ctx)
  )),
  truncated: z.boolean(),
  diagnostics: diagnosticsSchema.optional(),
}).superRefine((result, ctx) => {
  // An unavailable detail is a fact of absence: no text, no truncation claim.
  if (result.status === 'unavailable' && result.truncated) {
    ctx.addIssue({
      code: 'custom',
      message: 'unavailable detail must not claim truncation.',
      path: ['truncated'],
    });
  }
  if (result.status === 'unavailable' && result.text !== '') {
    ctx.addIssue({
      code: 'custom',
      message: 'unavailable detail must return empty text.',
      path: ['text'],
    });
  }
});

export type CustomizationKind = typeof CUSTOMIZATION_KINDS[number];
export type CustomizationListStatus = typeof CUSTOMIZATION_LIST_STATUSES[number];
export type InventoryCompleteness = typeof INVENTORY_COMPLETENESS[number];
export type CustomizationActivation = typeof CUSTOMIZATION_ACTIVATIONS[number];
export type CustomizationDiagnosticCode = typeof CUSTOMIZATION_DIAGNOSTIC_CODES[number];
export type RuleEffectStatus = typeof RULE_EFFECT_STATUSES[number];
export type CustomizationItem = z.infer<typeof customizationItemSchema>;
export type CustomizationListParams = z.infer<typeof customizationListParamsSchema>;
export type CustomizationDetailParams = z.infer<typeof customizationDetailParamsSchema>;
export type CustomizationListResult = z.infer<typeof customizationListResultSchema>;
export type CustomizationDetailResult = z.infer<typeof customizationDetailResultSchema>;
export type RuleCustomizationItem = z.infer<typeof ruleCustomizationItemSchema>;export type CustomizationDiagnostic = { code: CustomizationDiagnosticCode; message: string };
export type CustomizationWarning = CustomizationDiagnostic;
