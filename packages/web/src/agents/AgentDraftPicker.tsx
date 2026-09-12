import type { ProxyCatalogItem } from '@gian/shared';
import { useT } from '../i18n/index.js';
import { AgentLogo } from '../components/AgentLogo.js';

/**
 * Panel-2 first step of a new Agent draft (2026-09-07 owner call): "Add
 * Agent" opens this picker instead of flashing the Catalog section — the
 * Proxy choice IS the first step inside the form. Rows are the Catalog items
 * the Host projects as creatable; picking one starts the prefilled draft.
 */
export function AgentDraftPicker({
  items,
  syncing,
  showBack,
  onPick,
  onClose,
}: {
  /** Catalog items already filtered to the creatable set. */
  items: ProxyCatalogItem[];
  /** A Catalog sync is populating the list right now. */
  syncing: boolean;
  showBack: boolean;
  onPick: (item: ProxyCatalogItem) => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <>
      <div className="p2-head">
        {showBack && (
          <button type="button" className="btn icon ghost" aria-label={t('agents.detail.back')}
                  onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
        )}
        <span className="p2-title">{t('settings.agents.add')}</span>
        <span className="spacer" />
        <button type="button" className="btn icon ghost" aria-label={t('agents.detail.close')}
                onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6 6 18" /><path d="m6 6 12 12" />
          </svg>
        </button>
      </div>
      <div className="p2-body">
        <div className="s2-subhead">{t('agents.draft.pickProxy')}</div>
        <div className="catalog">
          {items.map(item => (
            <button
              key={item.pluginId}
              type="button"
              className="catalog-item"
              data-testid={`agent-draft-pick-${item.pluginId}`}
              onClick={() => onPick(item)}
            >
              <AgentLogo proxy={null} logo={item.logo} fallback={item.displayName} size={28} />
              <span className="grow">
                <span className="catalog-name">{item.displayName}</span>
                <span className="catalog-sub ellip" title={item.tagline}>{item.tagline}</span>
              </span>
            </button>
          ))}
        </div>
        {items.length === 0 && (
          <p className="s2-help">
            {syncing ? t('agents.catalog.syncing') : t('agents.catalog.empty')}
          </p>
        )}
      </div>
    </>
  );
}
