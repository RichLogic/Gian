import type { ProxyCatalogItem } from '@gian/shared';
import { useT } from '../i18n/index.js';
import { catalogBadges } from './catalog-model.js';
import type { CatalogBadge } from './catalog-model.js';

const BADGE_CLASS: Record<CatalogBadge, string> = {
  'update-required': 'st run',
  'installed': 'st ok',
  'not-installed': 'st muted',
};

const BADGE_KEY: Record<CatalogBadge, string> = {
  'update-required': 'agents.catalog.badge.update',
  'installed': 'agents.catalog.badge.installed',
  'not-installed': 'agents.catalog.badge.notInstalled',
};

/** Exactly one user-facing installation state per Integration. */
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
