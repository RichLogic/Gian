/**
 * Session Fork presentation helpers (gian.proxy/2.0 proposal §10.6,
 * `docs/proposals/gian-proxy-v2-ui-bridge.md`).
 *
 * A Fork creates a NORMAL persistent Gian Session with lineage metadata
 * (`Session.origin`). The copy here only ever says what fork IS — a new
 * session continuing from a stable history boundary of its parent. It must
 * never describe fork as a Rewind, Git branch, Worktree, file snapshot,
 * isolation, or rollback (§10.6, §23 — asserted in fork-controls.test.tsx
 * against the i18n values themselves).
 *
 * Everything is pure so the banner stays testable without mounting the app.
 */
import type { SessionOrigin } from '@gian/shared';

/**
 * Parent label for the origin line: the parent session's current name when
 * the caller resolved it from the sessions list, else a short-id fallback
 * (the parent may be archived or outside the loaded window — the lineage
 * display must still work).
 */
export function forkOriginParentLabel(
  origin: SessionOrigin,
  parentName?: string,
): string {
  return parentName ?? origin.session_id.slice(0, 8);
}

/**
 * The origin banner line for a forked session: names the parent session and,
 * for a turn-anchored fork, the exact boundary turn id reported by the Host
 * (§10.6 — shown verbatim, never re-derived). Head forks carry no boundary.
 */
export function forkOriginText(
  t: (key: string) => string,
  origin: SessionOrigin,
  parentName?: string,
): string {
  const name = forkOriginParentLabel(origin, parentName);
  return origin.turn_id
    ? t('fork.origin.fromTurn').replace('{name}', name).replace('{turn}', origin.turn_id)
    : t('fork.origin.from').replace('{name}', name);
}
