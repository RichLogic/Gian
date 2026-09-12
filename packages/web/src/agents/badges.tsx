import type { ProxyCatalogItem } from '@gian/shared';
import { useT } from '../i18n/index.js';
import { catalogBadges } from './catalog-model.js';
import type { CatalogBadge } from './catalog-model.js';

const BADGE_CLASS: Record<CatalogBadge, string> = {
  'update-available': 'st run',
  'installed': 'st ok',
  'setup-required': 'st warn',
  'requires-app-update': 'st err',
  'requires-proxy-update': 'st err',
  'invalid': 'st err',
  'not-installed': 'st muted',
};

const BADGE_KEY: Record<CatalogBadge, string> = {
  'update-available': 'agents.catalog.badge.update',
  'installed': 'agents.catalog.badge.installed',
  'setup-required': 'agents.catalog.badge.setup',
  'requires-app-update': 'agents.catalog.badge.appUpdate',
  'requires-proxy-update': 'agents.catalog.badge.proxyUpdate',
  'invalid': 'agents.catalog.badge.invalid',
  'not-installed': 'agents.catalog.badge.notInstalled',
};

/** Quiet status badges (dot + text) for one Catalog item — the same list
 *  renders on the card and in the detail head. */
export function CatalogBadgeList({ item }: { item: ProxyCatalogItem }) {
  const t = useT();
  return (
    <>
      {catalogBadges(item).map(badge => (
        <span key={badge} className={BADGE_CLASS[badge]} data-badge={badge}>
          <span className="st-dot" />
          {t(BADGE_KEY[badge])}
        </span>
      ))}
    </>
  );
}
