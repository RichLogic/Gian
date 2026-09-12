import type { Hono } from 'hono';

import {
  CUSTOMIZATION_KINDS,
  isCustomizationStableId,
  type CustomizationKind,
} from '@gian/proxy-protocol';
import {
  CustomizationInventoryService,
  CustomizationRequestError,
} from '../../proxy/customization-inventory.js';

function parseKind(raw: string): CustomizationKind | null {
  return (CUSTOMIZATION_KINDS as readonly string[]).includes(raw) ? raw as CustomizationKind : null;
}

function parseKinds(query: string | undefined): CustomizationKind[] | null {
  if (query === undefined || query === '') return [...CUSTOMIZATION_KINDS];
  const kinds: CustomizationKind[] = [];
  for (const part of query.split(',')) {
    const kind = parseKind(part.trim());
    if (kind === null) return null;
    kinds.push(kind);
  }
  return kinds.length > 0 ? kinds : null;
}

function isRefresh(query: string | undefined): boolean {
  return query === '1';
}

/**
 * Read-only Customization Inventory HTTP surface (Issue #50). The browser may
 * only submit a registered `workspaceId` — never an arbitrary path. 4xx is
 * reserved for request-level problems; per-kind outcomes live inside each
 * kind's Result, so a failing kind never makes the page fail.
 */
export function registerCustomizationRoutes(
  app: Hono,
  service: CustomizationInventoryService,
): void {
  app.get('/api/agents/:agentId/customizations', async c => {
    const agentId = c.req.param('agentId');
    const workspaceId = c.req.query('workspaceId') ?? null;
    const kinds = parseKinds(c.req.query('kinds'));
    if (kinds === null) {
      return c.json({ error: 'kinds must be a comma-separated subset of skill,mcp,hook,rule' }, 400);
    }
    try {
      const body = await service.inspectKinds({
        agentId,
        workspaceId,
        kinds,
        refresh: isRefresh(c.req.query('refresh')),
      });
      return c.json(body);
    } catch (error) {
      if (error instanceof CustomizationRequestError) {
        return c.json({ error: error.message }, error.status);
      }
      return c.json({ error: 'customization inventory unavailable' }, 502);
    }
  });

  app.get('/api/agents/:agentId/customizations/:kind/items/:itemId', async c => {
    const agentId = c.req.param('agentId');
    const kind = parseKind(c.req.param('kind'));
    const itemId = c.req.param('itemId');
    if (kind === null) {
      return c.json({ error: 'kind must be one of skill,mcp,hook,rule' }, 404);
    }
    if (!isCustomizationStableId(itemId)) {
      return c.json({ error: 'customization item not found' }, 404);
    }
    const workspaceId = c.req.query('workspaceId') ?? null;
    try {
      const body = await service.inspectDetail({
        agentId,
        workspaceId,
        kind,
        itemId,
        refresh: isRefresh(c.req.query('refresh')),
      });
      return c.json(body);
    } catch (error) {
      if (error instanceof CustomizationRequestError) {
        return c.json({ error: error.message }, error.status);
      }
      return c.json({ error: 'customization detail unavailable' }, 502);
    }
  });
}