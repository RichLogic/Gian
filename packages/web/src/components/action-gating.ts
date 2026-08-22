/**
 * Catalog/Session Action gating (gian.proxy/2.0 proposal §7.2, §9.4, §10.3).
 *
 * Side Chat and Fork controls are Gian standard UI: they are ALWAYS visible
 * and only ever greyed out — never hidden based on Provider id, model name,
 * version string, session state, or runtime error text (§9.4, §10.3, §23).
 * Enabled requires BOTH layers:
 *
 * 1. Catalog layer (§9.4): the current Catalog View's `actions` must declare
 *    the Action with `supported:true`. A missing descriptor is equivalent to
 *    `supported:false`.
 * 2. Session layer (§10.3): the Session snapshot's `available_actions` must
 *    carry the Action with `enabled:true`. Catalog-supported but missing
 *    from the dynamic snapshot means "temporarily unavailable" → greyed.
 *
 * `session.fork.atTurn` additionally requires `session.fork` enabled at both
 * layers (§7.2/§10.3: atTurn support/enablement implies plain fork's).
 */
import type { SessionActionAvailability } from '@gian/shared';

import type { CatalogActionDescriptor } from './composer/capabilities.js';

export interface ActionControlState {
  /** Standard controls are always visible (§9.4/§15) — kept in the result so
   *  callers never re-derive it. */
  visible: true;
  enabled: boolean;
  /** Proxy/session-provided grey-out reason; undefined → callers render the
   *  generic i18n "not supported/unavailable" fallback (§9.4/§10.3). */
  reason?: string;
}

function catalogSupported(
  catalogActions: readonly CatalogActionDescriptor[] | undefined,
  id: string,
): CatalogActionDescriptor | undefined {
  return catalogActions?.find(descriptor => descriptor.id === id && descriptor.supported === true);
}

function sessionEnabled(
  availableActions: Record<string, SessionActionAvailability> | undefined,
  id: string,
): SessionActionAvailability | undefined {
  const entry = availableActions?.[id];
  return entry?.enabled === true ? entry : undefined;
}

/**
 * Resolve one Action's control state from the two gating layers. Pure and
 * heuristic-free: no Provider-id/model/version branching anywhere.
 */
export function actionControlState(
  catalogActions: readonly CatalogActionDescriptor[] | undefined,
  availableActions: Record<string, SessionActionAvailability> | undefined,
  id: string,
): ActionControlState {
  const descriptor = catalogActions?.find(entry => entry.id === id);
  const dynamic = availableActions?.[id];
  // Reason precedence: the session's dynamic reason describes the CURRENT
  // blocker (§10.3); the catalog reason explains static non-support (§9.4).
  const reason = dynamic?.reason ?? descriptor?.reason;

  const enabled = catalogSupported(catalogActions, id) !== undefined
    && sessionEnabled(availableActions, id) !== undefined
    // §7.2/§10.3: forking AT a turn requires plain fork at both layers too.
    && (id !== 'session.fork.atTurn' || (
      catalogSupported(catalogActions, 'session.fork') !== undefined
      && sessionEnabled(availableActions, 'session.fork') !== undefined
    ));

  return {
    visible: true,
    enabled,
    ...(reason !== undefined ? { reason } : {}),
  };
}
