/**
 * Native `x.ai/*` extension-method support detection for the stdio
 * `grok agent` runtime.
 *
 * Live verification against the published 1.0.41 binary (2026-09-25) showed
 * that its stdio surface registers NONE of the `x.ai/*` extension request
 * methods the source tree carries handlers for: `x.ai/interject`,
 * `x.ai/session/rename`, `x.ai/session/fork`, `x.ai/session/usage`,
 * `x.ai/skills/list`, and `x.ai/mcp/list` all answer JSON-RPC -32601
 * "Method not found" — before and after `session/new`. The initialize
 * metadata (`_meta.grokShell`, `_meta.agentVersion`, `agentCapabilities`)
 * advertises no per-method extension surface either, so a version floor
 * proves nothing: `agentVersion >= 1.0.0` was sufficient for the source but
 * not for the shipped binary.
 *
 * Policy (honest by default):
 *  - Every method starts `unknown` and `supports()` reports false until the
 *    runtime POSITIVELY confirms it on this attach.
 *  - A method is confirmed by a successful call and refuted by a -32601
 *    "Method not found" response. A refuted method fails fast for the rest
 *    of the attach instead of repeating the live misreport.
 *  - A future upstream contract that advertises per-method support in
 *    initialize metadata can pre-confirm through `advertise()`.
 */

export type GrokExtMethodState = 'unknown' | 'confirmed' | 'refuted';

export const GROK_EXT_METHODS = [
  'x.ai/interject',
  'x.ai/session/fork',
  'x.ai/session/rename',
  'x.ai/session/delete',
  'x.ai/session/update_mcp_servers',
  'x.ai/session/usage',
  'x.ai/mcp/list',
  'x.ai/skills/list',
  'x.ai/hooks/list',
] as const;

export type GrokExtMethod = (typeof GROK_EXT_METHODS)[number];

export function isGrokExtMethod(value: string): value is GrokExtMethod {
  return (GROK_EXT_METHODS as readonly string[]).includes(value);
}

export interface GrokExtensionSupport {
  /** True when the runtime identifies itself as the stdio grok agent. */
  readonly grokShell: boolean;
  readonly agentVersion: string | null;
  /** True only for methods positively confirmed on this attach. */
  supports(method: GrokExtMethod): boolean;
  state(method: GrokExtMethod): GrokExtMethodState;
  /** True while the first real call may still probe an unknown method. */
  mayAttempt(method: GrokExtMethod): boolean;
  confirm(method: GrokExtMethod): void;
  refute(method: GrokExtMethod): void;
  /** Pre-confirm from upstream initialize metadata (future contract). */
  advertise(methods: readonly string[]): void;
  /** Human-readable reason a method is unavailable, for honest CAPABILITY_NOT_SUPPORTED errors. */
  unsupportedReason(method: GrokExtMethod): string;
}

class LiveExtensionSupport implements GrokExtensionSupport {
  private readonly states = new Map<GrokExtMethod, GrokExtMethodState>();

  constructor(
    readonly grokShell: boolean,
    readonly agentVersion: string | null,
  ) {}

  private check(method: GrokExtMethod): GrokExtMethodState {
    return this.states.get(method) ?? 'unknown';
  }

  supports(method: GrokExtMethod): boolean {
    return this.check(method) === 'confirmed';
  }

  state(method: GrokExtMethod): GrokExtMethodState {
    return this.check(method);
  }

  mayAttempt(method: GrokExtMethod): boolean {
    // Without the stdio-agent identity there is nothing to probe: the x.ai/*
    // surface is a grok-shell feature.
    return this.grokShell && this.check(method) !== 'refuted';
  }

  confirm(method: GrokExtMethod): void {
    this.states.set(method, 'confirmed');
  }

  refute(method: GrokExtMethod): void {
    this.states.set(method, 'refuted');
  }

  advertise(methods: readonly string[]): void {
    for (const value of methods) {
      if (isGrokExtMethod(value)) this.states.set(value, 'confirmed');
    }
  }

  unsupportedReason(method: GrokExtMethod): string {
    if (!this.grokShell) {
      return `Grok runtime does not identify itself as the stdio grok agent; ${method} is unavailable.`;
    }
    const state = this.check(method);
    if (state === 'refuted') {
      return `The Grok runtime's stdio surface answered "Method not found" for ${method}; it is not registered on this attach.`;
    }
    if (state === 'unknown') {
      return `${method} was never confirmed on this Grok runtime (the stdio agent publishes no per-method capability metadata), so it is treated as unsupported until a live call proves otherwise.`;
    }
    return `${method} is not available in this Grok runtime.`;
  }
}

export const NO_EXTENSION_SUPPORT: GrokExtensionSupport = new LiveExtensionSupport(false, null);

export function extensionSupportFromInitialize(
  initialized: { _meta?: unknown } | null | undefined,
): GrokExtensionSupport {
  const meta = initialized && typeof initialized === 'object'
    ? (initialized as { _meta?: unknown })._meta
    : undefined;
  if (!meta || typeof meta !== 'object') return NO_EXTENSION_SUPPORT;
  const record = meta as Record<string, unknown>;
  const grokShell = record.grokShell === true;
  const agentVersion = typeof record.agentVersion === 'string' && record.agentVersion.trim()
    ? record.agentVersion.trim()
    : null;
  const support = new LiveExtensionSupport(grokShell, agentVersion);
  // Future upstream contract: an explicit per-method surface advertisement in
  // initialize _meta pre-confirms those methods. 1.0.41 publishes none, so
  // this stays silent for it.
  const advertised = record['x.ai/extMethods'];
  if (Array.isArray(advertised)) {
    support.advertise(advertised.map((value) => String(value)));
  }
  return support;
}
