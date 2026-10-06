import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { agentHome } from './home.js';
import { unwrapExtMethodResult } from '../runtime/acp-wire.js';

/**
 * Isolation boundary for session-level Host Streamable HTTP MCP injection.
 *
 * The stdio grok agent merges MCP servers from several sources
 * (config.toml `[mcp_servers]`, plugins, imported vendor configs, and the
 * client-provided `mcpServers` list), and its permission deny rules
 * short-circuit in order — an `Allow` rule can never exempt a matching `Deny`.
 * Replacing the Proxy's blanket `--deny MCPTool(*)` with an allowlist is
 * therefore impossible; instead the boundary is:
 *
 *  1. Admission — only Host-approved Streamable HTTP descriptors are injected
 *     (`{ type: 'http', name, url }`). Stdio/SSE descriptors are rejected: the
 *     Host must not be able to execute local processes through MCP injection.
 *  2. Spawn-time deny enumeration — every disk-configured server name that
 *     the Host did not override is denied per name (`MCPTool(<name>__*)`), so
 *     disk-sourced MCP servers cannot execute tools even in always-approve
 *     mode. When no Host MCP is injected the original blanket
 *     `--deny MCPTool(*)` stays in force.
 *  3. Runtime verification — when Host MCP is admitted, `x.ai/mcp/list` must
 *     prove the executable set before any prompt. A miss, an unresolved
 *     catalog, or an executable server outside the admitted HTTP set fails
 *     the session. Logging the mismatch is not the boundary.
 *
 * Scanning here only reads configuration files; it never connects to an MCP
 * server and never executes a hook.
 */

export const MAX_HOST_MCP_SERVERS = 8;
export const MAX_HOST_MCP_NAME_LENGTH = 64;
export const MAX_HOST_MCP_URL_LENGTH = 2048;
export const MAX_HOST_MCP_HEADERS = 16;
const HOST_MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface HostMcpServiceDescriptor {
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

export interface AdmittedHostMcp {
  /** ACP `McpServer` payloads for `session/new`/`session/load`/`session/resume`. */
  readonly servers: Array<Record<string, unknown>>;
  /** Approved server names for runtime verification. */
  readonly names: readonly string[];
}

export class McpAdmissionError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'McpAdmissionError';
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Parse and admit Host `hostServices.integration.mcp.streamableHttp`
 * descriptors. Mirrors the descriptor shape used by the Kimi Proxy so Hosts
 * send one format: `{ id, protocol: 'mcp', transport: { type:
 * 'streamable-http', url, headers } }`.
 */
export function admitHostStreamableHttpServices(hostServices: unknown): AdmittedHostMcp {
  // Hosts send an array of service descriptors (same shape as the Kimi Proxy
  // contract): [{ id, protocol: 'mcp', transport: { type: 'streamable-http', url, headers } }].
  const rawList = hostServices;
  if (!Array.isArray(rawList) || rawList.length === 0) {
    throw new McpAdmissionError('hostServices must be a non-empty array of MCP service descriptors.');
  }
  if (rawList.length > MAX_HOST_MCP_SERVERS) {
    throw new McpAdmissionError(
      `Host MCP injection is limited to ${MAX_HOST_MCP_SERVERS} servers per session.`,
    );
  }
  const seen = new Set<string>();
  const servers: Array<Record<string, unknown>> = [];
  const names: string[] = [];
  for (const raw of rawList) {
    const service = record(raw);
    const id = nonEmptyString(service.id);
    const transport = record(service.transport);
    const url = nonEmptyString(transport.url);
    if (!id || service.protocol !== 'mcp') {
      throw new McpAdmissionError('Each Host MCP service requires id and protocol "mcp".');
    }
    if (transport.type !== 'streamable-http') {
      throw new McpAdmissionError(
        `Host MCP service ${id}: only transport type "streamable-http" is supported; stdio and SSE injection is rejected.`,
      );
    }
    if (!url || !isHttpUrl(url) || url.length > MAX_HOST_MCP_URL_LENGTH) {
      throw new McpAdmissionError(
        `Host MCP service ${id}: transport.url must be an absolute http(s) URL.`,
      );
    }
    if (!HOST_MCP_NAME_PATTERN.test(id) || id.length > MAX_HOST_MCP_NAME_LENGTH) {
      throw new McpAdmissionError(
        `Host MCP service id "${id}" must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}.`,
      );
    }
    if (seen.has(id)) {
      throw new McpAdmissionError(`Host MCP service id "${id}" was sent twice.`);
    }
    seen.add(id);
    const headers: Array<{ name: string; value: string }> = [];
    const rawHeaders = record(transport.headers);
    const headerNames = Object.keys(rawHeaders);
    if (headerNames.length > MAX_HOST_MCP_HEADERS) {
      throw new McpAdmissionError(`Host MCP service ${id}: at most ${MAX_HOST_MCP_HEADERS} headers are allowed.`);
    }
    for (const name of headerNames) {
      const value = rawHeaders[name];
      if (typeof value !== 'string') {
        throw new McpAdmissionError(`Host MCP service ${id}: transport headers must be strings.`);
      }
      headers.push({ name, value });
    }
    servers.push({ type: 'http', name: id, url, ...(headers.length > 0 ? { headers } : {}) });
    names.push(id);
  }
  return { servers, names };
}

export function grokHome(): string {
  // The same Provider Home rule as the child spawn env: GIAN_AGENT_HOME
  // first, legacy GROK_HOME next, the machine default last. Scanning anywhere
  // else would build a spawn boundary from a directory the CLI never reads.
  const home = agentHome(process.env);
  return home && isAbsolute(home)
    ? home
    : join(homedir(), '.grok');
}

async function readTextBounded(path: string, maxBytes: number): Promise<string | null> {
  try {
    const stat = await fsp.lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) return null;
    return await fsp.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Extract `[mcp_servers.<name>]` table names from a grok config.toml. */
export function mcpServerNamesFromToml(content: string): string[] {
  const names: string[] = [];
  const tablePattern = /^\s*\[\s*mcp_servers\s*\.\s*(?:"([^"\]]+)"|([^\]\s"#]+))\s*\]\s*$/gm;
  for (const match of content.matchAll(tablePattern)) {
    const raw = match[1] ?? match[2] ?? '';
    const name = raw.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function mcpServerNamesFromJson(content: string): string[] {
  try {
    const parsed = JSON.parse(content) as unknown;
    const root = record(parsed);
    // grok `.mcp.json` uses { mcpServers: { ... } }; Claude imports use the
    // same key; cursor's file nests under { mcpServers } as well.
    const servers = record(root.mcpServers ?? root.servers);
    return Object.keys(servers).filter((name) => name.length > 0);
  } catch {
    return [];
  }
}

export interface DiskMcpScan {
  readonly names: readonly string[];
  /** Non-fatal notes when a source exists but could not be parsed. */
  readonly diagnostics: readonly string[];
  /** True when a source existed but could not be read. A disk scan is not
   *  the effective MCP set. */
  readonly unreadable: boolean;
}

/**
 * Enumerate disk-configured MCP server names from every source the stdio
 * agent merges (global config.toml, project `.mcp.json`, and the imported
 * vendor configs). Read-only; no server is contacted. `userHome` overrides
 * the OS home for the user-level vendor imports (tests isolate this).
 */
export async function scanDiskConfiguredMcpServers(
  cwd: string | null,
  overrides: { userHome?: string } = {},
): Promise<DiskMcpScan> {
  const diagnostics: string[] = [];
  let unreadable = false;
  const names = new Set<string>();
  const userHome = overrides.userHome ?? homedir();
  const sources: Array<{ path: string | null; parse: (content: string) => string[]; label: string }> = [
    { path: join(grokHome(), 'config.toml'), parse: mcpServerNamesFromToml, label: 'grok config.toml' },
    { path: cwd ? join(cwd, '.mcp.json') : null, parse: mcpServerNamesFromJson, label: 'project .mcp.json' },
    { path: cwd ? join(cwd, '.claude.json') : null, parse: mcpServerNamesFromJson, label: 'project .claude.json' },
    { path: join(userHome, '.claude.json'), parse: mcpServerNamesFromJson, label: 'user .claude.json' },
    { path: join(grokHome(), 'mcp.json'), parse: mcpServerNamesFromJson, label: 'grok mcp.json' },
  ];
  for (const source of sources) {
    if (!source.path) continue;
    let content: string | null = null;
    let exists = false;
    try {
      const stat = await fsp.stat(source.path).catch(() => null);
      if (!stat) continue;
      exists = true;
      content = stat.isFile()
        ? await readTextBounded(source.path, 4 * 1024 * 1024)
        : null;
    } catch {
      content = null;
    }
    if (content === null) {
      // A present-but-unreadable source is an honest partial fact: the
      // boundary cannot enumerate it, so say so instead of staying silent.
      if (exists || await fsp.lstat(source.path).then(() => true, () => false)) {
        unreadable = true;
        diagnostics.push(`${source.label} exists but could not be read for MCP name enumeration.`);
      }
      continue;
    }
    if (content.includes('mcp_servers') || content.includes('mcpServers') || content.includes('"servers"')) {
      for (const name of source.parse(content)) names.add(name);
    }
  }
  return { names: [...names], diagnostics, unreadable };
}

/**
 * Spawn-time `--deny` rules for MCP tools.
 *
 * Without admitted Host servers the blanket `MCPTool(*)` deny from the
 * previous isolation policy is kept. With Host servers, every
 * disk-configured name that the Host list does not override is denied
 * individually, so only Host-approved servers can ever execute tools.
 */
export function mcpSpawnDenyRules(admitted: AdmittedHostMcp | null, diskNames: readonly string[]): string[] {
  if (!admitted || admitted.servers.length === 0) return ['MCPTool(*)'];
  const approved = new Set(admitted.names);
  const rules: string[] = [];
  for (const name of diskNames) {
    if (approved.has(name)) continue;
    rules.push(`MCPTool(${name}__*)`);
  }
  return rules;
}

export function buildSpawnArgs(
  denyRules: readonly string[],
  options: { disallowMetaTools?: boolean } = {},
): string[] {
  const args: string[] = [];
  for (const rule of denyRules) {
    args.push('--deny', rule);
  }
  if (options.disallowMetaTools !== false) {
    args.push('--disallowed-tools', 'search_tool,use_tool');
  }
  return args;
}

export interface ListedMcpServer {
  name: string;
  type: string | null;
  url: string | null;
  sourceLabel: string | null;
  executable: boolean;
  initializing: boolean;
}

export interface McpListReading {
  resolved: boolean | null;
  initializing: boolean;
  servers: ListedMcpServer[];
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Parse `x.ai/mcp/list`. Accepts the business object or an ExtMethodResult envelope. */
export function readMcpListPayload(raw: unknown): McpListReading {
  const body = objectRecord(unwrapExtMethodResult('x.ai/mcp/list', raw));
  if (!body || !Array.isArray(body.servers)) {
    throw new Error('x.ai/mcp/list did not return a server catalog.');
  }
  const resolvedValue = body.sessionMcpResolved ?? body.session_mcp_resolved;
  const resolved = typeof resolvedValue === 'boolean' ? resolvedValue : null;
  const servers = body.servers.map((entry): ListedMcpServer => {
    const server = objectRecord(entry) ?? {};
    const session = objectRecord(server.session);
    const enabled = session && Object.prototype.hasOwnProperty.call(session, 'enabled')
      ? session.enabled !== false
      : true;
    const status = session && (typeof session.status === 'string' ? session.status : '');
    const sourceLabel = typeof server.sourceLabel === 'string'
      ? server.sourceLabel
      : typeof server.source_label === 'string'
        ? server.source_label
        : null;
    return {
      name: typeof server.name === 'string' ? server.name : '',
      type: typeof server.type === 'string' ? server.type : null,
      url: typeof server.url === 'string' ? server.url : null,
      sourceLabel,
      executable: enabled && typeof server.name === 'string' && server.name.length > 0,
      initializing: status === 'initializing',
    };
  });
  return {
    resolved,
    initializing: servers.some((server) => server.initializing),
    servers,
  };
}

/**
 * Fail-closed comparison of the executable catalog to the admitted Host HTTP
 * set. Disabled entries are ignored. Messages do not include header values.
 */
export function mcpBoundaryProblem(
  servers: readonly ListedMcpServer[],
  admitted: AdmittedHostMcp,
): string | null {
  const approved = new Map<string, string>();
  for (const server of admitted.servers) {
    const name = typeof server.name === 'string' ? server.name : '';
    const url = typeof server.url === 'string' ? server.url : '';
    if (name) approved.set(name, url);
  }
  for (const server of servers) {
    if (!server.executable || server.initializing) continue;
    const expected = approved.get(server.name);
    if (!expected) {
      return `MCP server "${server.name}" is executable and was not admitted by the Host.`;
    }
    if (server.sourceLabel?.startsWith('plugin:')) {
      return `MCP server "${server.name}" is provided by a plugin, not the admitted Host server.`;
    }
    if (server.type === 'stdio' || server.type === 'managedGateway') {
      return `MCP server "${server.name}" uses ${server.type}, which Host admission does not allow.`;
    }
    if (server.type !== 'http' || server.url !== expected) {
      return `MCP server "${server.name}" does not match the admitted Host HTTP server.`;
    }
  }
  for (const name of admitted.names) {
    const live = servers.find((server) => server.name === name && server.executable && !server.initializing);
    if (!live) return `Admitted Host MCP server "${name}" is not executable in the Grok catalog.`;
  }
  return null;
}

/** Names present in the effective set but not approved by the Host. */
export function unexpectedMcpServerNames(effective: readonly string[], approved: readonly string[]): string[] {
  const allow = new Set(approved);
  return effective.filter((name) => !allow.has(name));
}
