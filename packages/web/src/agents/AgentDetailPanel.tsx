import { useEffect, useRef, useState } from 'react';
import type {
  AgentProxyDefaults,
  ConfigValue,
  UserAgentStatus,
} from '@gian/shared';
import { loadProxyCapabilities, loadResolvedProxyCatalog } from '../api.js';
import { useT } from '../i18n/index.js';
import { AgentLogo } from '../components/AgentLogo.js';
import {
  catalogFromCapabilities,
  executorSettingsFromCapabilities,
} from '../components/composer/capabilities.js';
import { agentIdEntityKey } from '../operations/agents.js';
import { usePendingOperations } from '../operations/use-operations.js';
import type { ProxyLogoDisplay } from './catalog-model.js';

/** One saved Agent owns identity, HOME and defaults. Its shared Proxy + CLI
 * Runtime lifecycle belongs to the Agent Integrations surface, never here. */
export function AgentDetailPanel({
  agent,
  display,
  showBack,
  errorNotice,
  onRename,
  onSetDefaults,
  onDelete,
  onOpenProxy,
  onClose,
}: {
  agent: UserAgentStatus;
  display: ProxyLogoDisplay;
  showBack: boolean;
  errorNotice: React.ReactNode;
  onRename: (name: string) => Promise<boolean>;
  onSetDefaults: (defaults: Partial<AgentProxyDefaults>) => Promise<boolean>;
  onDelete: () => void;
  /** Present only when the Agent's pluginId has a Catalog entry. */
  onOpenProxy?: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const kind = agent.proxy;
  const agentRuns = usePendingOperations(agentIdEntityKey(agent.id));
  const busy = agentRuns.length > 0;
  const [name, setName] = useState(agent.name);
  const [capabilities, setCapabilities] = useState<unknown>(null);
  const [resolvedCapabilities, setResolvedCapabilities] = useState<unknown>(null);
  const [resolvedModel, setResolvedModel] = useState('');
  const [resolvingDefaults, setResolvingDefaults] = useState(false);
  const resolveSequence = useRef(0);
  const [capabilityError, setCapabilityError] = useState(false);
  useEffect(() => setName(agent.name), [agent.name]);
  // Capability-driven Defaults exist only for official Proxy kinds: the
  // capabilities endpoint and the defaults validator are still kind-keyed.
  useEffect(() => {
    let alive = true;
    resolveSequence.current += 1;
    setCapabilities(null);
    setResolvedCapabilities(null);
    setResolvedModel('');
    setResolvingDefaults(false);
    setCapabilityError(false);
    if (!kind || agent.plugin.state !== 'ready') return () => { alive = false; };
    loadProxyCapabilities(kind, agent.id)
      .then(value => {
        if (alive) setCapabilities(value);
      })
      .catch(() => {
        if (alive) setCapabilityError(true);
      });
    return () => { alive = false; };
  }, [agent.id, kind, agent.cliPath, agent.plugin.state, agent.plugin.version]);

  async function commitName() {
    const next = name.trim();
    if (!next || next === agent.name) {
      setName(agent.name);
      return;
    }
    if (!(await onRename(next))) setName(agent.name);
  }

  const defaults = agent.defaults;
  const settingsCapabilities = resolvedCapabilities ?? capabilities;
  const { models, thinkingLevels: catalogThinking, modes } =
    executorSettingsFromCapabilities(kind, settingsCapabilities);
  const baseCatalog = catalogFromCapabilities(capabilities);
  // Effort vs Thinking label follows the Proxy's advertised option role,
  // not a hardcoded Provider branch.
  const thinkingLabelKey = baseCatalog.configOptions.some(option => option.role === 'effort')
    ? 'settings.executors.effort'
    : 'settings.executors.thinking';
  const selectedModel = models.find(model => model.model === defaults.model)
    ?? models.find(model => model.isDefault)
    ?? models[0];
  const modelThinking = selectedModel
    ? ('supportedEfforts' in selectedModel
        ? selectedModel.supportedEfforts
        : selectedModel.supportedThinking)
    : [];
  const thinkingLevels = catalogThinking.length > 0
    ? catalogThinking
    : modelThinking.filter((level): level is string => typeof level === 'string' && level.length > 0);
  const selectedMode = modes.some(mode => mode.id === defaults.mode)
    ? defaults.mode
    : modes.find(mode => mode.isDefault)?.id ?? modes[0]?.id ?? '';

  function configWithModel(
    model: string,
  ): { sessionConfig: Record<string, ConfigValue>; turnConfig: Record<string, ConfigValue> } {
    const sessionConfig: Record<string, ConfigValue> = {};
    const turnConfig: Record<string, ConfigValue> = {};
    const option = baseCatalog.configOptions.find(candidate => candidate.role === 'model');
    if (option && model) {
      (option.binding === 'session' ? sessionConfig : turnConfig)[option.id] = model;
    }
    return { sessionConfig, turnConfig };
  }

  async function changeDefaultModel(model: string): Promise<void> {
    if (!kind) return;
    const modelOption = baseCatalog.configOptions.find(option => option.role === 'model');
    const canResolve = !!model
      && !!modelOption
      && !!baseCatalog.catalogRevision
      && baseCatalog.resolveAdvertised;
    if (!canResolve) {
      setResolvedCapabilities(null);
      setResolvedModel('');
      const nextModel = models.find(candidate => candidate.model === model)
        ?? models.find(candidate => candidate.isDefault)
        ?? models[0];
      const supported = nextModel
        ? ('supportedEfforts' in nextModel
            ? nextModel.supportedEfforts
            : nextModel.supportedThinking).filter((level): level is string => (
              typeof level === 'string' && level.length > 0
            ))
        : [];
      await onSetDefaults({
        model,
        ...(defaults.thinking && !supported.includes(defaults.thinking)
          ? { thinking: '' }
          : {}),
      });
      return;
    }

    const sequence = ++resolveSequence.current;
    setResolvingDefaults(true);
    try {
      const config = configWithModel(model);
      const resolved = await loadResolvedProxyCatalog(kind, {
        catalogRevision: baseCatalog.catalogRevision!,
        ...config,
      }, agent.id);
      if (resolveSequence.current !== sequence) return;
      setResolvedCapabilities(resolved);
      setResolvedModel(model);
      const resolvedThinking = executorSettingsFromCapabilities(kind, resolved).thinkingLevels;
      await onSetDefaults({
        model,
        ...(defaults.thinking && !resolvedThinking.includes(defaults.thinking)
          ? { thinking: '' }
          : {}),
      });
    } catch {
      if (resolveSequence.current !== sequence) return;
      setResolvedCapabilities(null);
      setResolvedModel('');
      await onSetDefaults({ model, ...(defaults.thinking ? { thinking: '' } : {}) });
    } finally {
      if (resolveSequence.current === sequence) setResolvingDefaults(false);
    }
  }

  useEffect(() => {
    if (
      !capabilities
      || !defaults.model
      || !!resolvedCapabilities
      || resolvedModel === defaults.model
      || !baseCatalog.resolveAdvertised
      || !baseCatalog.catalogRevision
      || !baseCatalog.configOptions.some(option => (
        option.role === 'model' && option.choices?.some(choice => String(choice.value) === defaults.model)
      ))
    ) {
      return;
    }
    void changeDefaultModel(defaults.model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilities, defaults.model]);

  const defaultsEditable = !!kind && agent.ready
    && (models.length > 0 || thinkingLevels.length > 0 || modes.length > 0 || capabilityError);
  const externalHome = agent.home === null;

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
        <AgentLogo proxy={kind} logo={display.logo ?? undefined} fallback={display.name} size={28} />
        <input
          className="exec-name-input"
          value={name}
          spellCheck={false}
          aria-label={t('settings.agents.name')}
          disabled={busy}
          onChange={event => setName(event.target.value)}
          onBlur={() => { void commitName(); }}
          onKeyDown={event => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
            if (event.key === 'Escape') setName(agent.name);
          }}
        />
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
        {errorNotice}

        <section className="ag-sec">
          <span className="s2-subhead">{t('agents.integration')}</span>
          <div className="sec-line">
            <span className="rt-line">
              <AgentLogo proxy={kind} logo={display.logo ?? undefined}
                         fallback={display.name} size={20} />
              <span className="catalog-name">{display.name}</span>
              <span className="mono hint">{agent.pluginId}</span>
            </span>
            {onOpenProxy && (
              <button type="button" className="btn xs secondary" disabled={busy}
                      onClick={onOpenProxy}>
                {t('agents.detail.viewInCatalog')}
              </button>
            )}
          </div>
        </section>

        <section className="ag-sec">
          <span className="s2-subhead">{externalHome ? t('agents.home.state') : 'HOME'}</span>
          {externalHome ? (
            <p className="s2-help">{t('agents.home.externalHelp')}</p>
          ) : (
            <div className="sec-line">
              <span className="mono cli-path-val" data-testid="agent-home-path">
                {agent.home?.path ?? '—'}
              </span>
            </div>
          )}
        </section>

        <section className="ag-sec">
          <span className="s2-subhead">{t('agents.detail.defaults')}</span>
          {defaultsEditable ? (
              <div className="exec-defaults">
                {models.length > 0 && (
                  <label className="exec-default">
                    <span className="lbl">{t('settings.executors.defaultModel')}</span>
                    <select
                      className="select mono"
                      value={defaults.model}
                      disabled={busy || resolvingDefaults || !capabilities}
                      onChange={event => {
                        const model = event.target.value;
                        void changeDefaultModel(model);
                      }}
                    >
                      <option value="">{t('settings.executors.proxyDefault')}</option>
                      {models.filter(model => model.model !== '').map(model => (
                        <option key={model.id} value={model.model}>
                          {model.displayName || model.model}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {thinkingLevels.length > 0 && (
                  <label className="exec-default">
                    <span className="lbl">{t(thinkingLabelKey)}</span>
                    <select
                      className="select mono"
                      value={defaults.thinking}
                      disabled={busy || resolvingDefaults || !capabilities}
                      onChange={event => void onSetDefaults({ thinking: event.target.value })}
                    >
                      <option value="">{t('settings.executors.modelDefault')}</option>
                      {thinkingLevels.map(level => (
                        <option key={level} value={level}>{level}</option>
                      ))}
                    </select>
                  </label>
                )}
                {(modes.length > 0 || capabilityError) && (
                  <label className="exec-default">
                    <span className="lbl">{t('settings.executors.mode')}</span>
                    {modes.length > 0 ? (
                      <select
                        className="select mono"
                        value={selectedMode}
                        disabled={busy || resolvingDefaults || !capabilities}
                        onChange={event => void onSetDefaults({ mode: event.target.value })}
                      >
                        {modes.map(mode => (
                          <option key={mode.id} value={mode.id}>{mode.label}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="s2-help">{t('settings.executors.status.unavailable')}</span>
                    )}
                  </label>
                )}
              </div>
            ) : !kind ? (
              <p className="exec-note">{t('agents.detail.defaultsReadonly')}</p>
            ) : !agent.ready ? (
              <>
                <div className="exec-defaults">
                  <label className="exec-default">
                    <span className="lbl">{t('settings.executors.defaultModel')}</span>
                    <select className="select mono" disabled value="">
                      <option value="">{t('settings.executors.proxyDefault')}</option>
                    </select>
                  </label>
                  <label className="exec-default">
                    <span className="lbl">{t('settings.executors.thinking')}</span>
                    <select className="select mono" disabled value="">
                      <option value="">{t('settings.executors.modelDefault')}</option>
                    </select>
                  </label>
                  <label className="exec-default">
                    <span className="lbl">{t('settings.executors.mode')}</span>
                    <select className="select mono" disabled value="">
                      <option value="">{t('settings.executors.mode')}</option>
                    </select>
                  </label>
                </div>
                <p className="exec-note">{t('agents.detail.defaultsAfterSetup')}</p>
              </>
            ) : null}
        </section>
      </div>
      <div className="p2-foot">
        <span className="spacer" />
        <button
          type="button"
          className="btn sm danger-ghost"
          disabled={busy}
          onClick={onDelete}
        >
          {t('settings.agents.delete')}
        </button>
      </div>
    </>
  );
}
