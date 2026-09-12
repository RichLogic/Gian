import { realpathSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import {
  CUSTOMIZATION_KINDS,
  customizationDetailResultSchema,
  redactCustomizationValue,
  type CustomizationDetailResult,
  type CustomizationDiagnostic,
  type CustomizationKind,
  type CustomizationListResult,
} from '@gian/proxy-protocol';
import {
  InspectionUnavailableError,
  inspectionProfileIdentity,
  type ProxyManager,
} from './manager.js';

export const CUSTOMIZATION_CACHE_TTL_MS = 30_000;
export const CUSTOMIZATION_INSPECTION_TIMEOUT_MS = 20_000;

export class CustomizationRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

export interface CustomizationAgentFacts {
  agentId: string;
  pluginId: string;
  cliPath: string | null;
  proxyVersion: string | null;
  ready: boolean;
  /** Authoritative Session Runtime Profile identity when the Agent resolved
   *  one (immutable profile content hash). Null for legacy Agents. */
  runtimeProfileId: string | null;
  /** Provider config home the profile snapshot was resolved against. */
  configHome: string | null;
  /** Provider launcher/runtime content identity of the profile snapshot. */
  cliFingerprint: string | null;
}

interface WorkspaceRow {
  path?: string;
}

export interface CustomizationInventoryServiceOptions {
  manager: ProxyManager;
  resolveAgent: (agentId: string) => Promise<CustomizationAgentFacts>;
  /** Minimal workspace lookup seam; production passes Host's SQLite `Db`. */
  workspaceLookup: (workspaceId: string) => WorkspaceRow | undefined;
  now?: () => number;
  cacheTtlMs?: number;
}

interface CacheEntry {
  expiresAt: number;
  result: CustomizationListResult;
}

/** The immutable runtime identity the cache/host key is built on. The
 *  authoritative Session Runtime Profile id plus configHome/cliFingerprint
 *  are part of the key: two Agents sharing a CLI path must never read each
 *  other's cached results, and a profile change must never reuse a cache or
 *  host belonging to another identity. The identity uses the SAME facts the
 *  ProxyManager keys inspection hosts by (inspectionProfileIdentity), so a
 *  cache entry and the host that produced it always agree on identity. */
function profileKey(facts: CustomizationAgentFacts): string {
  const identity = inspectionProfileIdentity(facts) ?? '';
  return [
    facts.pluginId,
    facts.cliPath ?? '',
    facts.proxyVersion ?? '',
    identity,
  ].join('\u0000');
}

function unavailableResult(
  kind: CustomizationKind,
  diagnostics: CustomizationDiagnostic[],
): CustomizationListResult {
  return {
    kind,
    status: 'unavailable',
    completeness: 'none',
    observedAt: new Date().toISOString(),
    items: [],
    truncated: false,
    diagnostics,
  };
}

function proxyUpgradeRequiredResult(kind: CustomizationKind): CustomizationListResult {
  return proxyUnsupportedResult(kind, [{
    code: 'PROXY_UPGRADE_REQUIRED',
    message: 'The Agent runtime demands a Proxy artifact version this Host cannot launch for inspection.',
  }]);
}

function proxyUnsupportedResult(
  kind: CustomizationKind,
  diagnostics: CustomizationDiagnostic[],
): CustomizationListResult {
  return {
    kind,
    status: 'proxy_unsupported',
    completeness: 'none',
    observedAt: new Date().toISOString(),
    items: [],
    truncated: false,
    diagnostics,
  };
}

function sanitizedInspectionFailure(kind: CustomizationKind): CustomizationListResult {
  return unavailableResult(kind, [{
    code: 'PROVIDER_INSPECTION_FAILED',
    message: 'Provider inspection failed; the result is temporarily unavailable.',
  }]);
}

export interface InspectKindsInput {
  agentId: string;
  workspaceId: string | null;
  kinds: CustomizationKind[];
  refresh: boolean;
}

export interface InspectKindsOutput {
  agentId: string;
  workspaceId: string | null;
  fetchedAt: string;
  kinds: Partial<Record<CustomizationKind, CustomizationListResult>>;
}

export interface InspectDetailInput {
  agentId: string;
  workspaceId: string | null;
  kind: CustomizationKind;
  itemId: string;
  refresh: boolean;
}

interface InspectionHandleLike {
  host: {
    initialize(): Promise<{
      protocol: { version: string };
      capabilities: Record<string, number>;
    }>;
    request<T>(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<T>;
  };
  shared: boolean;
  release(): Promise<void>;
}

/**
 * Read-only Customization Inventory composition (Issue #50). Owns
 * Agent/Workspace routing, per-kind 30s cache, aggregate single-flight,
 * per-kind error isolation, transient inspection Host lifecycle, and the
 * second redaction layer. Never writes Provider configuration, never creates
 * a Provider Session, and never branches on Provider internals.
 */
export class CustomizationInventoryService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly aggregates = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly cacheTtlMs: number;

  constructor(private readonly options: CustomizationInventoryServiceOptions) {
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = options.cacheTtlMs ?? CUSTOMIZATION_CACHE_TTL_MS;
  }

  /** Agent resolution seam: a missing saved Agent is a 404 request
   *  condition (never a 502 backend failure). */
  private async resolveFactsOrThrow(agentId: string): Promise<CustomizationAgentFacts> {
    try {
      return await this.options.resolveAgent(agentId);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('agent not found:')) {
        throw new CustomizationRequestError('agent not found', 404);
      }
      throw error;
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  async inspectKinds(input: InspectKindsInput): Promise<InspectKindsOutput> {
    // Repeated kinds are one kind: dedupe at the Service boundary so a list
    // like `skill,skill` never issues the same wire RPC twice.
    const kinds = [...new Set(input.kinds.length > 0 ? input.kinds : [...CUSTOMIZATION_KINDS])];
    const facts = await this.resolveFactsOrThrow(input.agentId);
    const cwd = input.workspaceId === null ? null : this.workspacePathOrThrow(input.workspaceId);
    // The refresh flag is part of the single-flight key: an explicit refresh
    // must never join a warm-cache read's no-op aggregate and silently reuse
    // stale results. Two same-mode aggregates still single-flight.
    const aggregateKey = [
      profileKey(facts),
      input.workspaceId ?? '',
      [...kinds].sort().join(','),
      input.refresh ? 'refresh' : 'read',
    ].join('\u0000');
    const existing = this.aggregates.get(aggregateKey);
    const run = existing
      ?? this.runAggregate(aggregateKey, facts, input.workspaceId, cwd, kinds, input.refresh);
    if (!existing) this.aggregates.set(aggregateKey, run);
    try {
      await run;
    } finally {
      if (this.aggregates.get(aggregateKey) === run) this.aggregates.delete(aggregateKey);
    }
    const out: InspectKindsOutput = {
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      fetchedAt: new Date().toISOString(),
      kinds: {},
    };
    for (const kind of kinds) {
      const entry = this.cache.get(this.cacheKey(facts, input.workspaceId, kind));
      out.kinds[kind] = entry?.result ?? sanitizedInspectionFailure(kind);
    }
    return out;
  }

  async inspectDetail(input: InspectDetailInput): Promise<CustomizationDetailResult> {
    // The detail route only serves item ids the current list actually
    // contains; an unknown id or an unavailable list is a 404, never a probe.
    const facts = await this.resolveFactsOrThrow(input.agentId);
    const cwd = input.workspaceId === null ? null : this.workspacePathOrThrow(input.workspaceId);
    const listed = await this.inspectKinds({
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      kinds: [input.kind],
      refresh: input.refresh,
    });
    const result = listed.kinds[input.kind];
    if (result === undefined || result.status !== 'ok') {
      throw new CustomizationRequestError('customization item not found', 404);
    }
    if (!result.items.some(item => item.id === input.itemId)) {
      throw new CustomizationRequestError('customization item not found', 404);
    }
    return this.withHost(facts, async handle => {
      const raw = await handle.host.request(
        'customization.detail',
        { kind: input.kind, id: input.itemId, ...(cwd ? { cwd } : {}) },
        { timeoutMs: CUSTOMIZATION_INSPECTION_TIMEOUT_MS },
      );
      const redacted = redactCustomizationValue(raw);
      // Re-validate after redaction and pin the response to the requested
      // item: a Proxy answering with the wrong kind/id must never serve a
      // foreign item's content.
      const parsed = customizationDetailResultSchema.safeParse(redacted);
      if (!parsed.success || parsed.data.kind !== input.kind || parsed.data.id !== input.itemId) {
        throw new CustomizationRequestError('customization item not found', 404);
      }
      return parsed.data;
    });
  }

  private async runAggregate(
    aggregateKey: string,
    facts: CustomizationAgentFacts,
    workspaceId: string | null,
    cwd: string | null,
    kinds: CustomizationKind[],
    refresh: boolean,
  ): Promise<void> {
    const missing = kinds.filter(kind => (
      refresh || !this.cached(facts, workspaceId, kind)
    ));
    if (missing.length === 0) return;
    if (!facts.ready) {
      const diagnostics: CustomizationDiagnostic[] = [{
        code: 'PROVIDER_INSPECTION_FAILED',
        message: 'Agent runtime is not ready for inspection.',
      }];
      // Each kind gets its own structurally complete Result — never a
      // recycled result whose kind field describes a different slot.
      for (const kind of kinds) {
        this.cache.set(this.cacheKey(facts, workspaceId, kind), {
          expiresAt: this.now() + this.cacheTtlMs,
          result: unavailableResult(kind, diagnostics),
        });
      }
      return;
    }
    try {
      await this.withHost(facts, async handle => {
        const init = await handle.host.initialize();
        if (init.protocol.version !== '2.3' || init.capabilities['customization.list'] === undefined) {
          const diagnostics: CustomizationDiagnostic[] = [{
            code: 'PROXY_UPGRADE_REQUIRED',
            message: 'Customization inventory requires a Proxy that declares gian.proxy/2.3 customization.list',
          }];
          for (const kind of missing) {
            this.cache.set(this.cacheKey(facts, workspaceId, kind), {
              expiresAt: this.now() + this.cacheTtlMs,
              result: proxyUnsupportedResult(kind, diagnostics),
            });
          }
          return;
        }
        await Promise.all(missing.map(async kind => {
          try {
            const raw = await handle.host.request(
              'customization.list',
              { kind, ...(cwd ? { cwd } : {}) },
              { timeoutMs: CUSTOMIZATION_INSPECTION_TIMEOUT_MS },
            );
            // The client validator already schema-checked the Result; this is
            // the Host second redaction layer before anything reaches the API.
            const result = redactCustomizationValue(raw) as CustomizationListResult;
            this.cache.set(this.cacheKey(facts, workspaceId, kind), {
              expiresAt: this.now() + this.cacheTtlMs,
              result,
            });
          } catch {
            this.cache.set(this.cacheKey(facts, workspaceId, kind), {
              expiresAt: this.now() + this.cacheTtlMs,
              result: sanitizedInspectionFailure(kind),
            });
          }
        }));
      });
    } catch (error) {
      // The manager cannot launch the exact Proxy artifact the Agent's
      // runtime profile demands: report upgrade-required per kind instead of
      // silently inspecting with the wrong artifact.
      if (error instanceof InspectionUnavailableError) {
        for (const kind of missing) {
          this.cache.set(this.cacheKey(facts, workspaceId, kind), {
            expiresAt: this.now() + this.cacheTtlMs,
            result: proxyUpgradeRequiredResult(kind),
          });
        }
        return;
      }
      // Host-level inspection failure (spawn, protocol, shutdown) must not
      // fail the whole page: every missing kind returns a structurally
      // complete unavailable Result.
      for (const kind of missing) {
        this.cache.set(this.cacheKey(facts, workspaceId, kind), {
          expiresAt: this.now() + this.cacheTtlMs,
          result: sanitizedInspectionFailure(kind),
        });
      }
    }
    void aggregateKey;
  }

  private async withHost<T>(
    facts: CustomizationAgentFacts,
    fn: (handle: InspectionHandleLike) => Promise<T>,
  ): Promise<T> {
    let handle: InspectionHandleLike | null = null;
    try {
      handle = await this.options.manager.acquireInspectionHost(facts.pluginId, {
        agentId: facts.agentId,
        cliPath: facts.cliPath,
        proxyVersion: facts.proxyVersion,
        runtimeProfileId: facts.runtimeProfileId,
        configHome: facts.configHome,
        cliFingerprint: facts.cliFingerprint,
      });
      return await fn(handle);
    } finally {
      if (handle) await handle.release();
    }
  }

  private workspacePathOrThrow(workspaceId: string): string {
    const row = this.options.workspaceLookup(workspaceId);
    if (!row?.path) {
      throw new CustomizationRequestError('workspace not found', 404);
    }
    const canonical = canonicalizeWorkspacePath(row.path);
    // A registered Workspace whose directory is gone must not masquerade as
    // an empty inventory: it is a 409 (unavailable) request condition.
    let stat;
    try {
      stat = statSync(canonical);
    } catch {
      throw new CustomizationRequestError('workspace path is unavailable', 409);
    }
    if (!stat.isDirectory()) {
      throw new CustomizationRequestError('workspace path is unavailable', 409);
    }
    return canonical;
  }

  private cached(
    facts: CustomizationAgentFacts,
    workspaceId: string | null,
    kind: CustomizationKind,
  ): boolean {
    const entry = this.cache.get(this.cacheKey(facts, workspaceId, kind));
    return entry !== undefined && entry.expiresAt > this.now();
  }

  private cacheKey(
    facts: CustomizationAgentFacts,
    workspaceId: string | null,
    kind: CustomizationKind,
  ): string {
    return `${profileKey(facts)}\u0000${workspaceId ?? ''}\u0000${kind}`;
  }
}

export function canonicalizeWorkspacePath(path: string): string {
  const resolved = resolvePath(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}
