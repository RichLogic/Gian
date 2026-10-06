/**
 * Native `x.ai/*` extension-method support for one stdio attach.
 *
 * Custom methods travel as `_x.ai/...`. A bare `x.ai/...` request is not
 * evidence that the runtime lacks the method. `grokShell` and
 * `agentVersion` do not confirm a method. `supports()` stays false until
 * this attach confirms it. Only a JSON-RPC -32601 on the prefixed wire
 * refutes it. Timeouts, auth failures, and parameter errors leave the
 * method unknown.
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
  // An explicit per-method list in initialize _meta can pre-confirm. The
  // published stdio metadata does not include one, so this stays silent.
  const advertised = record['x.ai/extMethods'];
  if (Array.isArray(advertised)) {
    support.advertise(advertised.map((value) => String(value)));
  }
  return support;
}
