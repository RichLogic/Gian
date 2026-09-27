import { promises as fsp } from 'node:fs';

import {
  MAX_CUSTOMIZATION_ITEMS,
  redactShellCommandText,
  redactCustomizationTarget,
  stableCustomizationId,
  type CustomizationDetailResult,
  type CustomizationDiagnostic,
  type CustomizationItem,
  type CustomizationKind,
  type CustomizationListResult,
} from '@gian/proxy-protocol';

import type { GrokAcpClient } from '../runtime/grok-acp-client.js';
import { GrokExtMethodUnsupportedError } from '../runtime/grok-acp-client.js';

/**
 * Read-only Custom Skill / MCP / Hook inventory for the grok runtime.
 *
 * Everything here is introspection only: MCP servers come from the agent's
 * pure in-memory catalog (`x.ai/mcp/list` contacts nothing), skills from the
 * agent's disk reload (`x.ai/skills/list` executes nothing), and hooks from
 * the session's registered hook list (`x.ai/hooks/list`). No hook runs and no
 * MCP connection is opened by any code path in this module. Rules have no
 * native enumeration surface and are reported as honestly unsupported.
 */

const DETAIL_TEXT_MAX_BYTES = 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function truncateUtf8(value: string, max: number): string {
  const chars = [...value];
  return chars.length <= max ? value : `${chars.slice(0, max).join('')}…`;
}

function unsupportedList(
  kind: CustomizationKind,
  status: 'proxy_unsupported' | 'provider_unsupported',
  message: string,
): CustomizationListResult {
  return {
    kind,
    status,
    completeness: 'none',
    observedAt: new Date().toISOString(),
    items: [],
    truncated: false,
    diagnostics: [{ code: 'SOURCE_NOT_ENUMERABLE', message }],
  } as CustomizationListResult;
}

function unavailableDetail(kind: CustomizationKind, id: string, message: string): CustomizationDetailResult {
  return {
    kind,
    id,
    status: 'unavailable',
    observedAt: new Date().toISOString(),
    text: '',
    truncated: false,
    diagnostics: [{ code: 'PROVIDER_INSPECTION_FAILED', message }],
  } as CustomizationDetailResult;
}

function capItems(items: CustomizationItem[]): { kept: CustomizationItem[]; truncated: boolean } {
  if (items.length <= MAX_CUSTOMIZATION_ITEMS) return { kept: items, truncated: false };
  return { kept: items.slice(0, MAX_CUSTOMIZATION_ITEMS), truncated: true };
}

/** Redact an `x.ai/mcp/list` entry into a safe summary + origin locator. */
function redactMcpEntry(entry: Record<string, unknown>): {
  name: string;
  summary: string;
  transport: 'http' | 'sse' | 'stdio' | 'unknown';
  source: string | null;
} {
  const name = nonEmptyString(entry.name) ?? 'unnamed';
  const config = record(entry.config);
  const url = nonEmptyString(config.url);
  const command = nonEmptyString(config.command);
  const transport = url ? 'http' as const : command ? 'stdio' as const : 'unknown' as const;
  const source = nonEmptyString(entry.sourceLabel)
    ?? nonEmptyString(entry.source_label)
    ?? nonEmptyString(record(entry.source).label)
    ?? null;
  let summary: string;
  if (url) {
    // Keep scheme + host only; paths and query strings may carry credentials.
    try {
      const parsed = new URL(url);
      summary = `${parsed.protocol}//${parsed.host}`;
    } catch {
      summary = 'http server (unparseable url redacted)';
    }
  } else if (command) {
    summary = truncateUtf8(redactShellCommandText(command), 256);
  } else {
    summary = 'MCP server';
  }
  return { name, summary, transport, source };
}

export interface GrokCustomizationRuntimeAccess {
  /** Auxiliary short-lived runtime for global listings (no session needed). */
  createAuxRuntime(cwd: string): GrokAcpClient;
  /** Currently attached ordinary session's runtime + native id, when any. */
  attachedRuntime(): { runtime: GrokAcpClient; nativeSessionId: string; cwd: string } | null;
}

export class GrokCustomizationInspector {
  constructor(private readonly access: GrokCustomizationRuntimeAccess) {}

  async list(kind: CustomizationKind, params: { cwd?: string }): Promise<CustomizationListResult> {
    switch (kind) {
      case 'skill': return this.listSkills(params.cwd);
      case 'mcp': return this.listMcp(params.cwd);
      case 'hook': return this.listHooks();
      case 'rule':
      default:
        return unsupportedList(
          kind,
          'provider_unsupported',
          'Grok rules are instruction files the runtime blends into the system prompt; the runtime exposes no enumeration surface, so this Proxy reports none instead of guessing file locations.',
        );
    }
  }

  async detail(kind: CustomizationKind, id: string, params: { cwd?: string }): Promise<CustomizationDetailResult> {
    switch (kind) {
      case 'skill': return this.detailSkill(id, params.cwd);
      case 'mcp': return this.detailMcp(id, params.cwd);
      case 'hook': return this.detailHook(id);
      case 'rule':
      default:
        return unavailableDetail(kind, id, 'Grok rule detail is not supported by the runtime.');
    }
  }

  private async listSkills(cwd: string | undefined): Promise<CustomizationListResult> {
    const target = cwd ?? this.access.attachedRuntime()?.cwd ?? process.cwd();
    const aux = this.access.createAuxRuntime(target);
    try {
      await aux.ensureStarted();
      const response = record(await aux.skillsList(target));
      const skills = Array.isArray(response.skills) ? response.skills : [];
      const items: CustomizationItem[] = skills.map((raw) => {
        const skill = record(raw);
        const name = nonEmptyString(skill.name) ?? 'unnamed';
        const paths = Array.isArray(skill.paths)
          ? skill.paths.filter((item): item is string => typeof item === 'string')
          : [];
        return {
          id: stableCustomizationId({
            provider: 'grok',
            kind: 'skill',
            scopeKey: `cwd:${target}`,
            canonicalSourceLocator: paths[0] ?? name,
            nativeIdentity: name,
          }),
          kind: 'skill',
          name: truncateUtf8(name, 256),
          nativeType: 'grok.skill',
          nativeStatus: 'configured',
          activation: 'unknown',
          scope: { level: 'workspace', ...(cwd ? { root: cwd } : {}) },
          origin: { kind: 'project_file', ...(paths[0] ? { path: paths[0] } : {}) },
          discovery: { method: 'provider_introspection' as never },
          skill: {
            description: truncateUtf8(nonEmptyString(skill.description) ?? '', 1024),
            ...(paths.length > 0 ? { paths: paths.map((path) => truncateUtf8(path, 512)) } : {}),
          },
        } as unknown as CustomizationItem;
      });
      const capped = capItems(items);
      return {
        kind: 'skill',
        status: 'ok',
        completeness: capped.truncated ? 'partial' : 'configured',
        observedAt: new Date().toISOString(),
        items: capped.kept,
        truncated: capped.truncated,
        diagnostics: capped.truncated
          ? [{ code: 'INVENTORY_TRUNCATED', message: 'Skill inventory exceeded the item limit and was truncated.' } as CustomizationDiagnostic]
          : [],
      } as unknown as CustomizationListResult;
    } catch (error) {
      return this.nativeErrorList('skill', error);
    } finally {
      await aux.stop().catch(() => undefined);
    }
  }

  private async detailSkill(id: string, cwd: string | undefined): Promise<CustomizationDetailResult> {
    const listed = await this.listSkills(cwd);
    const match = listed.items.find((item) => item.id === id || item.name === id);
    if (!match) return unavailableDetail('skill', id, 'Grok skill was not found.');
    const paths = (match as unknown as { skill?: { paths?: string[] } }).skill?.paths ?? [];
    for (const path of paths.slice(0, 1)) {
      try {
        const stat = await fsp.lstat(path);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > DETAIL_TEXT_MAX_BYTES) continue;
        const text = await fsp.readFile(path, 'utf8');
        return {
          kind: 'skill',
          id,
          status: 'ok',
          observedAt: new Date().toISOString(),
          text: text.length > DETAIL_TEXT_MAX_BYTES
            ? text.slice(0, DETAIL_TEXT_MAX_BYTES)
            : text,
          truncated: stat.size > DETAIL_TEXT_MAX_BYTES,
          diagnostics: [],
        } as unknown as CustomizationDetailResult;
      } catch {
        /* try the next path */
      }
    }
    return unavailableDetail('skill', id, 'Grok skill definition file was not readable.');
  }

  private async listMcp(cwd: string | undefined): Promise<CustomizationListResult> {
    const target = cwd ?? this.access.attachedRuntime()?.cwd ?? process.cwd();
    const aux = this.access.createAuxRuntime(target);
    try {
      await aux.ensureStarted();
      const response = record(await aux.mcpList());
      const servers = Array.isArray(response.servers) ? response.servers : [];
      const items: CustomizationItem[] = servers.map((raw) => {
        const entry = record(raw);
        const redacted = redactMcpEntry(entry);
        return {
          id: stableCustomizationId({
            provider: 'grok',
            kind: 'mcp',
            scopeKey: `cwd:${target}`,
            canonicalSourceLocator: redacted.source ?? 'live',
            nativeIdentity: redacted.name,
          }),
          kind: 'mcp',
          name: truncateUtf8(redacted.name, 256),
          nativeType: `grok.mcp.${redacted.transport}`,
          // The agent's catalog is the merged EFFECTIVE set.
          nativeStatus: 'effective',
          activation: 'unknown',
          scope: { level: 'workspace', ...(cwd ? { root: cwd } : {}) },
          origin: { kind: 'provider_state' as never },
          discovery: { method: 'provider_introspection' as never },
          mcp: {
            transport: redacted.transport,
            targetSummary: truncateUtf8(redacted.summary, 512),
            ...(redacted.source ? { sourceLabel: truncateUtf8(redacted.source, 256) } : {}),
          },
        } as unknown as CustomizationItem;
      });
      const capped = capItems(items);
      return {
        kind: 'mcp',
        status: 'ok',
        completeness: capped.truncated ? 'partial' : 'effective',
        observedAt: new Date().toISOString(),
        items: capped.kept,
        truncated: capped.truncated,
        diagnostics: capped.truncated
          ? [{ code: 'INVENTORY_TRUNCATED', message: 'MCP inventory exceeded the item limit and was truncated.' } as CustomizationDiagnostic]
          : [],
      } as unknown as CustomizationListResult;
    } catch (error) {
      return this.nativeErrorList('mcp', error);
    } finally {
      await aux.stop().catch(() => undefined);
    }
  }

  private async detailMcp(id: string, cwd: string | undefined): Promise<CustomizationDetailResult> {
    const listed = await this.listMcp(cwd);
    const match = listed.items.find((item) => item.id === id || item.name === id);
    if (!match) return unavailableDetail('mcp', id, 'Grok MCP server was not found.');
    const mcp = (match as unknown as { mcp?: { transport?: string; targetSummary?: string; sourceLabel?: string } }).mcp ?? {};
    const text = JSON.stringify({
      name: match.name,
      transport: mcp.transport ?? 'unknown',
      target: redactCustomizationTarget(mcp.targetSummary ?? ''),
      ...(mcp.sourceLabel ? { source: mcp.sourceLabel } : {}),
    }, null, 2);
    return {
      kind: 'mcp',
      id,
      status: 'ok',
      observedAt: new Date().toISOString(),
      text,
      truncated: false,
      diagnostics: [],
    } as unknown as CustomizationDetailResult;
  }

  private async listHooks(): Promise<CustomizationListResult> {
    const attached = this.access.attachedRuntime();
    if (!attached) {
      return unsupportedList(
        'hook',
        'proxy_unsupported',
        'Grok hooks are per-session; attach a session before listing hooks.',
      );
    }
    try {
      const response = record(await attached.runtime.hooksList(attached.nativeSessionId));
      const hooks = Array.isArray(response.hooks)
        ? response.hooks
        : Array.isArray(response.items) ? response.items : [];
      const items: CustomizationItem[] = hooks.map((raw, index) => {
        const hook = record(raw);
        const event = nonEmptyString(hook.event) ?? nonEmptyString(hook.name) ?? 'hook';
        const command = nonEmptyString(hook.command)
          ?? nonEmptyString(record(hook.handler).command)
          ?? '';
        return {
          id: stableCustomizationId({
            provider: 'grok',
            kind: 'hook',
            scopeKey: `session:${attached.nativeSessionId}`,
            canonicalSourceLocator: 'x.ai/hooks/list',
            nativeIdentity: `${event}\u0000${index}\u0000${command}`,
          }),
          kind: 'hook',
          name: truncateUtf8(event, 256),
          nativeType: 'grok.hook.command',
          nativeStatus: 'effective',
          activation: 'unknown',
          scope: { level: 'workspace', root: attached.cwd },
          origin: { kind: 'provider_state' as never },
          discovery: { method: 'provider_introspection' as never },
          hook: {
            nativeEvent: truncateUtf8(event, 256),
            ...(nonEmptyString(hook.matcher) ? { matcher: truncateUtf8(String(hook.matcher), 256) } : {}),
            handler: {
              nativeType: 'command',
              targetSummary: truncateUtf8(redactShellCommandText(command), 4096),
            },
          },
        } as unknown as CustomizationItem;
      });
      const capped = capItems(items);
      return {
        kind: 'hook',
        status: 'ok',
        completeness: capped.truncated ? 'partial' : 'effective',
        observedAt: new Date().toISOString(),
        items: capped.kept,
        truncated: capped.truncated,
        diagnostics: capped.truncated
          ? [{ code: 'INVENTORY_TRUNCATED', message: 'Hook inventory exceeded the item limit and was truncated.' } as CustomizationDiagnostic]
          : [],
      } as unknown as CustomizationListResult;
    } catch (error) {
      return this.nativeErrorList('hook', error);
    }
  }

  private async detailHook(id: string): Promise<CustomizationDetailResult> {
    const listed = await this.listHooks();
    const match = listed.items.find((item) => item.id === id || item.name === id);
    if (!match) return unavailableDetail('hook', id, 'Grok hook was not found.');
    const hook = (match as unknown as { hook?: Record<string, unknown> }).hook ?? {};
    return {
      kind: 'hook',
      id,
      status: 'ok',
      observedAt: new Date().toISOString(),
      text: JSON.stringify(hook, null, 2),
      truncated: false,
      diagnostics: [],
    } as unknown as CustomizationDetailResult;
  }

  private nativeErrorList(kind: CustomizationKind, error: unknown): CustomizationListResult {
    const message = error instanceof GrokExtMethodUnsupportedError
      ? error.message
      : error instanceof Error ? error.message : String(error);
    const diagnostics: CustomizationDiagnostic[] = [{
      code: error instanceof GrokExtMethodUnsupportedError
        ? 'PROVIDER_INSPECTION_FAILED'
        : 'PROVIDER_INSPECTION_FAILED',
      message: `Grok ${kind} introspection failed: ${message}`,
    }];
    return {
      kind,
      status: 'provider_unsupported',
      completeness: 'none',
      observedAt: new Date().toISOString(),
      items: [],
      truncated: false,
      diagnostics,
    } as unknown as CustomizationListResult;
  }
}
