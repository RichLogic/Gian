/**
 * Open Proxy plugin identity. Same grammar as `@gian/proxy-protocol`
 * pluginIdSchema / Catalog `catalogPluginIdSchema`: reserved bare official
 * IDs or reverse-domain IDs. Unknown reverse-domain IDs are valid without a
 * registry edit.
 */

declare const proxyPluginIdBrand: unique symbol;

export type ProxyPluginId = string & { readonly [proxyPluginIdBrand]: 'ProxyPluginId' };

export const MAX_PROXY_PLUGIN_ID_CHARS = 128;

/** Reserved bare official IDs plus reverse-domain external IDs. */
export const PROXY_PLUGIN_ID_PATTERN =
  /^(?:claude|codex|kimi|grok|[a-z0-9]+(?:[.-][a-z0-9]+)+)$/;

export function isProxyPluginId(value: unknown): value is ProxyPluginId {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_PROXY_PLUGIN_ID_CHARS
    && PROXY_PLUGIN_ID_PATTERN.test(value);
}

/** Bare official IDs from the pluginId grammar. Reverse-domain IDs always
 *  contain `.` or `-`. AgentManager still owns these directories in Milestone A. */
export function isReservedOfficialPluginId(value: unknown): value is ProxyPluginId {
  return isProxyPluginId(value) && !value.includes('.') && !value.includes('-');
}

export function parseProxyPluginId(value: unknown): ProxyPluginId {
  if (!isProxyPluginId(value)) {
    throw new Error(`invalid pluginId: ${String(value)}`);
  }
  return value;
}
