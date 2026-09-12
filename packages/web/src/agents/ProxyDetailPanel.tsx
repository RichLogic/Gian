import { Fragment, useEffect, useRef, useState } from 'react';
import type { ManagedRuntimeStatus, ProxyCatalogItem, UserAgentStatus } from '@gian/shared';
import { loadCatalogDocument } from '../api.js';
import { useT } from '../i18n/index.js';
import { AgentLogo } from '../components/AgentLogo.js';
import { CatalogMarkdown } from './CatalogMarkdown.js';
import { compatibilityMessage } from './catalog-model.js';

export type ProxyDetailSection = 'basic' | 'tutorial' | 'versions';

const docCache = new Map<string, Promise<string | null>>();

export function loadCatalogDoc(url: string, generation: number | null): Promise<string | null> {
  const key = `${generation ?? 'none'}:${url}`;
  let cached = docCache.get(key);
  if (!cached) {
    cached = loadCatalogDocument(url).catch(error => {
      docCache.delete(key);
      throw error;
    });
    docCache.set(key, cached);
  }
  return cached;
}

export function __resetCatalogDocCache(): void {
  docCache.clear();
}

type DocState =
  | { state: 'loading' }
  | { state: 'ready'; text: string }
  | { state: 'missing' }
  | { state: 'error' };

function useCatalogDoc(url: string, generation: number | null): DocState {
  const [doc, setDoc] = useState<DocState>({ state: 'loading' });
  useEffect(() => {
    let alive = true;
    setDoc({ state: 'loading' });
    loadCatalogDoc(url, generation)
      .then(text => { if (alive) setDoc(text === null ? { state: 'missing' } : { state: 'ready', text }); })
      .catch(() => { if (alive) setDoc({ state: 'error' }); });
    return () => { alive = false; };
  }, [url, generation]);
  return doc;
}

function DocBody({ url, generation }: { url: string; generation: number | null }) {
  const t = useT();
  const doc = useCatalogDoc(url, generation);
  if (doc.state === 'loading') return <p className="s2-help">{t('agents.proxy.doc.loading')}</p>;
  if (doc.state === 'missing') return <p className="s2-help">{t('agents.proxy.doc.missing')}</p>;
  if (doc.state === 'error') return <p className="s2-help">{t('agents.proxy.doc.error')}</p>;
  return <CatalogMarkdown source={doc.text} />;
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
    </svg>
  );
}

/** One continuous product document. The top controls are scroll anchors, not tabs. */
export function ProxyDetailPanel({
  item,
  runtime,
  developmentFallback,
  docGeneration,
  showBack,
  busy,
  onAction,
  onCreateAgent,
  onClose,
}: {
  item: ProxyCatalogItem;
  runtime: ManagedRuntimeStatus | null;
  developmentFallback?: UserAgentStatus;
  docGeneration: number | null;
  showBack: boolean;
  busy: boolean;
  onAction: (action: 'install_runtime' | 'install_proxy' | 'update_proxy' | 'rollback_proxy') => void;
  onCreateAgent: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const bodyRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Record<ProxyDetailSection, HTMLElement | null>>({
    basic: null,
    tutorial: null,
    versions: null,
  });
  const [activeSection, setActiveSection] = useState<ProxyDetailSection>('basic');
  useEffect(() => {
    setActiveSection('basic');
    if (typeof bodyRef.current?.scrollTo === 'function') bodyRef.current.scrollTo({ top: 0 });
  }, [item.pluginId]);

  const generation = runtime?.active ?? null;
  const compat = compatibilityMessage(item);
  const actions = item.availableActions;
  const canUse = actions.includes('create_agent')
    || actions.includes('install_runtime')
    || actions.includes('install_proxy')
    || actions.includes('update_proxy');
  const cliPath = generation?.runtime?.entryPath ?? developmentFallback?.cli.path ?? null;
  const cliVersion = generation?.runtime?.version ?? developmentFallback?.cli.version ?? null;
  const proxyVersion = generation?.proxy.pluginVersion
    ?? developmentFallback?.plugin.version
    ?? item.installation.installedVersion
    ?? item.installation.latestVersion;

  function go(section: ProxyDetailSection) {
    setActiveSection(section);
    sectionRefs.current[section]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function trackSection() {
    const body = bodyRef.current;
    if (!body) return;
    const top = body.getBoundingClientRect().top + 64;
    let next: ProxyDetailSection = 'basic';
    for (const section of ['basic', 'tutorial', 'versions'] as const) {
      const node = sectionRefs.current[section];
      if (node && node.getBoundingClientRect().top <= top) next = section;
    }
    setActiveSection(next);
  }

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
        <AgentLogo proxy={null} logo={item.logo} fallback={item.displayName} size={28} />
        <span className="p2-title ellip" title={item.displayName}>{item.displayName}</span>
        <span className="spacer" />
        <button type="button" className="btn icon ghost" aria-label={t('agents.detail.close')}
                onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6 6 18" /><path d="m6 6 12 12" />
          </svg>
        </button>
      </div>

      <div className="p2-body proxy-document" ref={bodyRef} onScroll={trackSection}>
        <nav className="ag-tabs ag-anchors" aria-label={t('agents.proxy.sections.label')}>
          {(['basic', 'tutorial', 'versions'] as const).map(section => (
            <button key={section} type="button"
                    className={`ag-tab ${activeSection === section ? 'active' : ''}`}
                    data-testid={`proxy-anchor-${section}`}
                    onClick={() => go(section)}>
              {t(`agents.proxy.sections.${section}`)}
            </button>
          ))}
        </nav>

        {compat && (
          <div className="notice warn" role="status">
            <span><b>{t(compat.key)}</b>{compat.reason ? ` · ${compat.reason}` : ''}</span>
          </div>
        )}

        <section className="ag-sec proxy-doc-section" ref={node => { sectionRefs.current.basic = node; }}>
          <span className="s2-subhead">{t('agents.proxy.sections.basic')}</span>
          <p className="s2-help">{item.tagline}</p>
          <dl className="kv-grid">
            <dt>{t('agents.runtime.proxyVersionLabel')}</dt>
            <dd><span className="mono">{proxyVersion ?? t('agents.proxy.versions.none')}</span></dd>
            <dt>Runtime</dt>
            <dd>
              <span className="mono">{cliVersion ?? t('agents.runtime.notInstalled')}</span>
              {generation && <span className="hint">{t('agents.runtime.certified')}</span>}
            </dd>
            {generation?.companions.map(companion => (
              <Fragment key={companion.id}>
                <dt>{companion.id}</dt>
                <dd><span className="mono">{companion.version}</span></dd>
              </Fragment>
            ))}
            <dt>{t('agents.runtime.platform')}</dt>
            <dd>{generation?.platform ?? '—'}</dd>
            <dt>{t('agents.detail.pluginId')}</dt>
            <dd><span className="mono cli-path-val">{item.pluginId}</span></dd>
            <dt>{t('agents.runtime.process')}</dt>
            <dd>{generation?.proxy.processScope ?? '—'}</dd>
            <dt>{t('agents.runtime.cliPath')}</dt>
            <dd>
              <span className="rt-line">
                <span className="cli-path-val" title={cliPath ?? ''}>{cliPath ?? '—'}</span>
                {cliPath && (
                  <button type="button" className="btn icon ghost compact"
                          title={t('common.copy')} aria-label={t('common.copy')}
                          onClick={() => { void navigator.clipboard?.writeText(cliPath); }}>
                    <CopyIcon />
                  </button>
                )}
              </span>
            </dd>
          </dl>

          <div className="act-row">
            {actions.includes('install_runtime') && (
              <button type="button" className="btn xs primary" disabled={busy}
                      data-testid="proxy-action-install-runtime" onClick={() => onAction('install_runtime')}>
                {t('agents.catalog.action.installRuntime')}
              </button>
            )}
            {actions.includes('update_proxy') && (
              <>
                <span className="delta mono">
                  {t('agents.runtime.proxyDelta')
                    .replace('{current}', item.installation.installedVersion ?? '—')
                    .replace('{latest}', item.installation.latestVersion ?? '—')}
                </span>
                <button type="button" className="btn xs primary" disabled={busy}
                        data-testid="proxy-action-update" onClick={() => onAction('update_proxy')}>
                  {t('agents.catalog.action.update')}
                </button>
              </>
            )}
            {actions.includes('install_proxy') && (
              <button type="button" className="btn xs primary" disabled={busy}
                      data-testid="proxy-action-install" onClick={() => onAction('install_proxy')}>
                {t('agents.catalog.action.install')}
              </button>
            )}
            {actions.includes('rollback_proxy') && (
              <button type="button" className="btn xs ghost" disabled={busy}
                      data-testid="proxy-action-rollback" onClick={() => onAction('rollback_proxy')}>
                {t('agents.catalog.action.rollback')}
              </button>
            )}
            {!actions.some(action => action === 'install_runtime' || action === 'install_proxy' || action === 'update_proxy' || action === 'rollback_proxy') && (
              <span className="delta muted">{t('agents.runtime.current')}</span>
            )}
          </div>

          <DocBody url={item.documentation.overview} generation={docGeneration} />
        </section>

        <section className="ag-sec proxy-doc-section" ref={node => { sectionRefs.current.tutorial = node; }}>
          <span className="s2-subhead">{t('agents.proxy.sections.tutorial')}</span>
          <div className="proxy-doc-part">
            <DocBody url={item.documentation.setup} generation={docGeneration} />
          </div>
          <div className="proxy-doc-part">
            <DocBody url={item.documentation.usage} generation={docGeneration} />
          </div>
          <div className="proxy-doc-part">
            <DocBody url={item.documentation.troubleshooting} generation={docGeneration} />
          </div>
        </section>

        <section className="ag-sec proxy-doc-section" ref={node => { sectionRefs.current.versions = node; }}>
          <span className="s2-subhead">{t('agents.proxy.sections.versions')}</span>
          <dl className="kv-grid">
            <dt>{t('agents.proxy.versions.installed')}</dt>
            <dd><span className="mono">{item.installation.installedVersion ?? t('agents.proxy.versions.none')}</span></dd>
            <dt>{t('agents.proxy.versions.latest')}</dt>
            <dd><span className="mono">{item.installation.latestVersion ?? '—'}</span></dd>
            <dt>{t('agents.proxy.versions.source')}</dt>
            <dd>{item.installation.source ?? '—'}</dd>
          </dl>
          <p className="s2-help">{t('agents.proxy.changelogPending')}</p>
        </section>
      </div>

      {canUse && (
        <div className="p2-foot">
          <span className="spacer" />
          <button type="button" className="btn sm primary" disabled={busy}
                  data-testid="proxy-action-create-agent" onClick={onCreateAgent}>
            {t('agents.proxy.use')}
          </button>
        </div>
      )}
    </>
  );
}
