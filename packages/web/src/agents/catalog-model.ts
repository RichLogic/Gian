/**
 * Agents page (WP4, issue #146) — pure Catalog/Agent presentation model.
 * Everything here is manifest/pluginId-driven: the open `pluginId` string is
 * the only identity; no closed Executor unions, no Provider-specific copy.
 * The Host projection (`ProxyCatalogItem.availableActions`, compatibility
 * and installation states) is authoritative — these helpers only classify
 * for display, they never invent actions.
 */
import type {
  ProxyCatalogEntry,
  ProxyCatalogItem,
  UserAgentStatus,
} from '@gian/shared';

/** Catalog document keys served by `GET /api/proxies/:pluginId/docs/:doc`. */
export const CATALOG_DOC_KEYS = ['overview', 'setup', 'usage', 'troubleshooting'] as const;
export type CatalogDocKey = (typeof CATALOG_DOC_KEYS)[number];

/** Display classification for one Catalog card. Ordered by severity; the
 *  first entry is the card's primary badge. */
export type CatalogBadge =
  | 'update-available'
  | 'installed'
  | 'setup-required'
  | 'requires-app-update'
  | 'requires-proxy-update'
  | 'invalid'
  | 'not-installed';

export function catalogBadges(item: ProxyCatalogItem): CatalogBadge[] {
  const badges: CatalogBadge[] = [];
  if (item.compatibility.state === 'requires_app_update') badges.push('requires-app-update');
  else if (item.compatibility.state === 'requires_proxy_update') badges.push('requires-proxy-update');
  else if (item.compatibility.state === 'invalid') badges.push('invalid');

  if (item.installation.state === 'installed') {
    badges.push('installed');
    if (item.installation.updateAvailable) badges.unshift('update-available');
    if (item.runtime.state === 'setup_required') badges.push('setup-required');
  } else if (item.installation.state === 'invalid' || item.installation.state === 'quarantined') {
    if (!badges.includes('invalid')) badges.push('invalid');
  } else if (badges.length === 0) {
    badges.push('not-installed');
  }
  return badges;
}

/** Actions the page may render for one item — verbatim Host projection,
 *  filtered to the actions with a real backing endpoint or local flow.
 *  (`open_setup` / `select_runtime` land on the Setup tab's Runtime
 *  discover/probe flow, `create_agent` opens the draft; install/update/
 *  rollback hit the Host API.) */
export function catalogActions(item: ProxyCatalogItem): ProxyCatalogItem['availableActions'] {
  return item.availableActions;
}

/** Create-Agent affordance: exactly the Host-projected `create_agent`
 *  action. The Host alone decides actions (supply-chain/control-plane rule);
 *  Web never infers creatability from pluginId shape or installation state.
 *  NOTE (backend integration requirement): the Milestone A projection
 *  intentionally emits no actions for reserved official pluginIds, so those
 *  entries currently offer no in-page create affordance — the generic backend
 *  must project the real action before Web can surface it. */
export function canCreateAgent(item: ProxyCatalogItem): boolean {
  return item.availableActions.includes('create_agent');
}

/** True when the item stays visible but every install/enable path is off
 *  (incompatible with this App, or broken local install). */
export function isCatalogItemDisabled(item: ProxyCatalogItem): boolean {
  return item.compatibility.state !== 'compatible'
    || item.installation.state === 'invalid'
    || item.installation.state === 'quarantined';
}

/** i18n key + flag distinguishing "the App is too old" from "the Proxy is
 *  too old" — the two states need different user guidance. */
export function compatibilityMessage(item: ProxyCatalogItem): {
  key: 'agents.catalog.compat.appUpdate' | 'agents.catalog.compat.proxyUpdate'
    | 'agents.catalog.compat.invalid';
  reason: string | null;
} | null {
  switch (item.compatibility.state) {
    case 'requires_app_update':
      return { key: 'agents.catalog.compat.appUpdate', reason: item.compatibility.reason };
    case 'requires_proxy_update':
      return { key: 'agents.catalog.compat.proxyUpdate', reason: item.compatibility.reason };
    case 'invalid':
      return { key: 'agents.catalog.compat.invalid', reason: item.compatibility.reason };
    default:
      return null;
  }
}

/** Display identity for one saved Agent: prefer the Catalog projection
 *  (works for open pluginIds), fall back to the legacy kind metadata, then
 *  to the raw pluginId. Old Agents whose Proxy kind has no Catalog entry
 *  still render. */
export interface ProxyLogoDisplay {
  name: string;
  tagline: string;
  logo: { light: string; dark: string } | null;
}

export function agentProxyDisplay(
  agent: UserAgentStatus,
  catalog: ProxyCatalogItem[],
  legacyProxies: ProxyCatalogEntry[],
): ProxyLogoDisplay {
  const item = catalog.find(candidate => candidate.pluginId === agent.pluginId);
  if (item) return { name: item.displayName, tagline: item.tagline, logo: item.logo };
  const legacy = agent.proxy
    ? legacyProxies.find(candidate => candidate.id === agent.proxy)
    : undefined;
  if (legacy) return { name: legacy.name, tagline: legacy.tagline, logo: legacy.logo };
  // Pre-v4 legacy data may lack pluginId entirely — degrade to proxyName.
  return { name: agent.proxyName || String(agent.pluginId ?? ''), tagline: '', logo: null };
}

/** Draft name validation (ported from the Settings Agents block): trimmed,
 *  non-empty, case-insensitively unique across saved Agents. */
export function draftNameError(
  name: string,
  agents: UserAgentStatus[],
): 'empty' | 'taken' | null {
  const trimmed = name.trim();
  if (!trimmed) return 'empty';
  return agents.some(agent => agent.name.trim().toLowerCase() === trimmed.toLowerCase())
    ? 'taken'
    : null;
}
