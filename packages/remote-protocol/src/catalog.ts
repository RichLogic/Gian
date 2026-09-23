import { z } from 'zod';
import { nameSchema } from './validation.js';

export const remoteConfigValueSchema = z.union([z.string().max(16 * 1024), z.number().finite(), z.boolean(), z.null()]);
export const remoteConfigMapSchema = z.record(nameSchema, remoteConfigValueSchema).refine(value => Object.keys(value).length <= 128);
const condition = z.strictObject({ optionId: nameSchema, oneOf: z.array(remoteConfigValueSchema).min(1).max(256) });
export const remoteConfigOptionSchema = z.strictObject({
  id: nameSchema, displayName: nameSchema, description: z.string().max(16 * 1024).optional(),
  binding: z.enum(['session', 'turn']), role: nameSchema.optional(),
  control: z.enum(['select', 'boolean', 'number', 'text']), required: z.boolean(), defaultValue: remoteConfigValueSchema,
  choices: z.array(z.strictObject({ value: remoteConfigValueSchema, displayName: nameSchema,
    description: z.string().max(16 * 1024).optional() })).max(256).optional(),
  constraints: z.strictObject({ minimum: z.number().finite().optional(), maximum: z.number().finite().optional(),
    step: z.number().finite().positive().optional(), minimumLength: z.number().int().nonnegative().optional(),
    maximumLength: z.number().int().nonnegative().optional(), multiline: z.boolean().optional() }).optional(),
  visibleWhen: z.array(condition).max(128).optional(), enabledWhen: z.array(condition).max(128).optional(),
  presentation: z.strictObject({ group: nameSchema.optional(), order: z.number().int().optional(),
    placeholder: z.string().max(1024).optional(), sensitive: z.boolean().optional() }).optional(),
});
export const remoteAgentCatalogSchema = z.strictObject({
  catalogRevision: nameSchema.optional(),
  configOptions: z.array(remoteConfigOptionSchema).max(128),
  input: z.array(z.strictObject({ type: nameSchema, enabledWhen: z.array(condition).max(128).optional() })).max(32),
  specialCatalogs: z.strictObject({ model: nameSchema.optional(), thinking: nameSchema.optional(),
    fast: nameSchema.optional(), approvalMode: nameSchema.optional() }).optional(),
  actions: z.array(z.strictObject({ id: nameSchema, supported: z.boolean(), reason: z.string().max(4096).optional() })).max(64).optional(),
  sessionConfig: remoteConfigMapSchema.optional(), turnConfig: remoteConfigMapSchema.optional(),
  resolvedDefaults: z.strictObject({ sessionConfig: remoteConfigMapSchema, turnConfig: remoteConfigMapSchema }).optional(),
  resolveSupported: z.boolean(),
});
