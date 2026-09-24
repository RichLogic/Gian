import { useEffect, useRef, useState } from 'react';
import type {
  AgentProxyDefaults,
  ConfigOption,
  ConfigValue,
  UserAgentStatus,
} from '@gian/shared';
import { loadProxyCapabilities, loadResolvedProxyCatalog } from '../api.js';
import { useT } from '../i18n/index.js';
import { AgentLogo } from '../components/AgentLogo.js';
import {
  catalogFromCapabilities,
  executorSettingsFromCapabilities,
  optionEnabled,
  optionVisible,
} from '../components/composer/capabilities.js';
import { agentIdEntityKey } from '../operations/agents.js';
import { usePendingOperations } from '../operations/use-operations.js';
import type { ProxyLogoDisplay } from './catalog-model.js';

/** Section-heading ⓘ with a CSS hover/focus tooltip (the shared .help-hint
 *  pattern from gian-v2.css — no positioning JS). */
function HelpHint({ text }: { text: string }) {
  return (
    <span className="help-hint" tabIndex={0}>
      <span className="help-hint-trigger" aria-label={text}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" />
        </svg>
      </span>
      <span className="help-hint-pop" role="tooltip">{text}</span>
    </span>
  );
}

/** One saved Agent owns identity, HOME and defaults. Its shared Proxy + CLI
 * Runtime lifecycle belongs to the Agent Integrations surface, never here. */
export function AgentDetailPanel({
  agent,
  display,
  showBack,
  errorNotice,
  onRename,
  onSetDefaults,
  onSetEnabled,
  onChangeHome,
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
  onSetEnabled: (enabled: boolean) => Promise<boolean>;
  /** Native HOME picker + patch, wired by the view; absent for external-App
   *  Agents whose HOME is not Gian-managed. */
  onChangeHome?: () => Promise<void>;
  onDelete: () => void;
  /** Present only when the Agent's pluginId has a Catalog entry. */
  onOpenProxy?: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const kind = agent.proxy;
  const agentRuns = usePendingOperations(agentIdEntityKey(agent.id));
  const busy = agentRuns.length > 0;
  const [enabledPending, setEnabledPending] = useState(false);
  const [homeChanging, setHomeChanging] = useState(false);
  const enabled = agent.enabled !== false;
  const [name, setName] = useState(agent.name);
  const [capabilities, setCapabilities] = useState<unknown>(null);
  const [resolvedCapabilities, setResolvedCapabilities] = useState<unknown>(null);
  const [resolvedSignature, setResolvedSignature] = useState('');
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
    setResolvedSignature('');
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

  async function toggleEnabled(next: boolean): Promise<void> {
    setEnabledPending(true);
    try {
      await onSetEnabled(next);
    } finally {
      setEnabledPending(false);
    }
  }

  async function changeHome(): Promise<void> {
    setHomeChanging(true);
    try {
      await onChangeHome?.();
    } finally {
      setHomeChanging(false);
    }
  }
  const { models, thinkingLevels: catalogThinking, modes } =
    executorSettingsFromCapabilities(kind, settingsCapabilities);
  const baseCatalog = catalogFromCapabilities(capabilities);
  const effectiveCatalog = catalogFromCapabilities(settingsCapabilities);
  // Role-less select options (e.g. provider) persist as per-Agent defaults in
  // `defaults.options`; the Proxy stays the owner of resolution/validation.
  const extraOptions = effectiveCatalog.configOptions.filter(option => (
    !option.role && option.control === 'select' && (option.choices?.length ?? 0) > 0
  ));
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

  /** Effective defaults after a patch: triplet replaces, options merge per
   *  key with `null` deleting. Mirrors the Host merge semantics. */
  function mergedDefaults(patch: Partial<AgentProxyDefaults>): AgentProxyDefaults {
    const next: AgentProxyDefaults = {
      model: patch.model ?? defaults.model,
      thinking: patch.thinking ?? defaults.thinking,
      mode: patch.mode ?? defaults.mode,
      options: { ...(defaults.options ?? {}) },
    };
    if (patch.options !== undefined) {
      for (const [id, value] of Object.entries(patch.options)) {
        if (value === null) delete next.options[id];
        else next.options[id] = value;
      }
    }
    return next;
  }

  /** Mirror of the Host `configsFromDefaults`: map effective defaults onto
   *  the base catalog's ids and bindings for `catalog.resolve`. */
  function configsFromDefaults(
    value: AgentProxyDefaults,
  ): { sessionConfig: Record<string, ConfigValue>; turnConfig: Record<string, ConfigValue> } {
    const sessionConfig: Record<string, ConfigValue> = {};
    const turnConfig: Record<string, ConfigValue> = {};
    const assign = (option: ConfigOption, optionValue: ConfigValue): void => {
      (option.binding === 'session' ? sessionConfig : turnConfig)[option.id] = optionValue;
    };
    for (const option of baseCatalog.configOptions) {
      if (option.role === 'model' && value.model) assign(option, value.model);
      else if (option.role === 'effort' && value.thinking) assign(option, value.thinking);
      else if ((option.role === 'approval_mode' || option.role === 'execution_mode') && value.mode) {
        assign(option, value.mode);
      } else if (!option.role) {
        const optionValue = value.options?.[option.id];
        if (optionValue !== undefined) assign(option, optionValue);
      }
    }
    return { sessionConfig, turnConfig };
  }

  const defaultsConfig = configsFromDefaults(defaults);
  const defaultsSignature = JSON.stringify(defaultsConfig);
  // Condition inputs for visibleWhen/enabledWhen: explicit defaults beat the
  // Proxy's defaultValue for every advertised option.
  const conditionValues: Record<string, ConfigValue> = {};
  for (const option of effectiveCatalog.configOptions) {
    if (option.defaultValue !== null && option.defaultValue !== undefined) {
      conditionValues[option.id] = option.defaultValue;
    }
  }
  Object.assign(conditionValues, defaultsConfig.sessionConfig, defaultsConfig.turnConfig);

  /** One atomic defaults patch for any triplet field or role-less option.
   *  Resolves the full effective config against the Proxy first so dependent
   *  choices (provider → models) clear stale defaults in the same write. */
  async function changeDefaultOption(
    patch: Partial<AgentProxyDefaults>,
    { writeAlways = true }: { writeAlways?: boolean } = {},
  ): Promise<void> {
    if (!kind) return;
    const next = mergedDefaults(patch);
    const config = configsFromDefaults(next);
    const canResolve = !!baseCatalog.catalogRevision
      && !!baseCatalog.resolveAdvertised
      && (Object.keys(config.sessionConfig).length > 0 || Object.keys(config.turnConfig).length > 0);
    if (!canResolve) {
      setResolvedCapabilities(null);
      setResolvedSignature('');
      if (patch.model !== undefined) {
        const nextModel = models.find(candidate => candidate.model === patch.model)
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
          ...patch,
          ...(defaults.thinking && !supported.includes(defaults.thinking)
            ? { thinking: '' }
            : {}),
        });
      } else if (writeAlways || Object.keys(patch).length > 0) {
        await onSetDefaults(patch);
      }
      return;
    }

    const sequence = ++resolveSequence.current;
    setResolvingDefaults(true);
    try {
      const resolved = await loadResolvedProxyCatalog(kind, {
        catalogRevision: baseCatalog.catalogRevision!,
        ...config,
      }, agent.id);
      if (resolveSequence.current !== sequence) return;
      setResolvedCapabilities(resolved);
      setResolvedSignature(JSON.stringify(config));
      const resolvedCatalog = catalogFromCapabilities(resolved);
      const resolvedSettings = executorSettingsFromCapabilities(kind, resolved);
      const atomic: Partial<AgentProxyDefaults> = {
        ...patch,
        ...(patch.options ? { options: { ...patch.options } } : {}),
      };
      if (
        next.model
        && resolvedSettings.models.length > 0
        && !resolvedSettings.models.some(model => model.model === next.model)
      ) {
        atomic.model = '';
      }
      if (
        next.thinking
        && resolvedSettings.thinkingLevels.length > 0
        && !resolvedSettings.thinkingLevels.includes(next.thinking)
      ) {
        atomic.thinking = '';
      }
      if (
        next.mode
        && resolvedSettings.modes.length > 0
        && !resolvedSettings.modes.some(mode => mode.id === next.mode)
      ) {
        atomic.mode = '';
      }
      for (const [id, value] of Object.entries(next.options)) {
        const option = resolvedCatalog.configOptions.find(candidate => candidate.id === id);
        // Unknown ids stay on disk; known options whose value fell out of the
        // resolved choices get deleted in the same patch.
        if (option?.choices?.length && !option.choices.some(choice => Object.is(choice.value, value))) {
          atomic.options = { ...(atomic.options ?? {}), [id]: null };
        }
      }
      if (writeAlways || Object.keys(atomic).length > 0) await onSetDefaults(atomic);
    } catch {
      if (resolveSequence.current !== sequence) return;
      setResolvedCapabilities(null);
      setResolvedSignature('');
      if (writeAlways) {
        await onSetDefaults({
          ...patch,
          ...(patch.model !== undefined && defaults.thinking ? { thinking: '' } : {}),
        });
      }
    } finally {
      if (resolveSequence.current === sequence) setResolvingDefaults(false);
    }
  }

  // Re-resolve whenever the effective defaults signature changes so dependent
  // selects (thinking/models per model or provider) render the Proxy's own
  // choices; stale stored defaults are cleared by the same reconciliation.
  useEffect(() => {
    if (
      !capabilities
      || !!resolvedCapabilities
      || !baseCatalog.resolveAdvertised
      || !baseCatalog.catalogRevision
      || defaultsSignature === resolvedSignature
      || (Object.keys(defaultsConfig.sessionConfig).length === 0
        && Object.keys(defaultsConfig.turnConfig).length === 0)
    ) {
      return;
    }
    void changeDefaultOption({}, { writeAlways: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilities, defaultsSignature]);

  const defaultsEditable = !!kind && agent.ready
    && (models.length > 0 || thinkingLevels.length > 0 || modes.length > 0
      || extraOptions.length > 0 || capabilityError);
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
        {onOpenProxy && (
          <button type="button" className="btn icon ghost" disabled={busy}
                  data-testid="agent-open-integration"
                  title={t('agents.detail.viewInCatalog')}
                  aria-label={t('agents.detail.viewInCatalog')}
                  onClick={onOpenProxy}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M7 17 17 7" /><path d="M9 7h8v8" />
            </svg>
          </button>
        )}
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
          <span className="s2-subhead">
            {externalHome ? t('agents.home.state') : 'HOME'}
            <HelpHint text={t('agents.detail.homeHelp')} />
          </span>
          {externalHome ? (
            <p className="s2-help">{t('agents.home.externalHelp')}</p>
          ) : (
            <div className="sec-line">
              <span className="rt-line">
                <span className="mono cli-path-val" data-testid="agent-home-path">
                  {agent.home?.path ?? '—'}
                </span>
                {onChangeHome && (
                  <button type="button" className="btn xs ghost"
                          data-testid="agent-home-change"
                          disabled={busy || homeChanging}
                          onClick={() => { void changeHome(); }}>
                    {t('agents.detail.changeHome')}
                  </button>
                )}
              </span>
            </div>
          )}
        </section>

        <section className="ag-sec">
          <span className="s2-subhead">
            {t('agents.detail.defaults')}
            <HelpHint text={t('agents.detail.defaultsHelp')} />
          </span>
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
                        void changeDefaultOption({ model });
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
                {extraOptions.map(option => {
                  if (!optionVisible(option, conditionValues)) return null;
                  const current = defaults.options?.[option.id];
                  return (
                    <label className="exec-default" key={option.id}>
                      <span className="lbl">{option.displayName}</span>
                      <select
                        className="select mono"
                        data-testid={`agent-default-option-${option.id}`}
                        value={current === undefined || current === null ? '' : String(current)}
                        disabled={busy || resolvingDefaults || !capabilities
                          || !optionEnabled(option, conditionValues)}
                        onChange={event => {
                          const value = event.target.value;
                          // Empty means the Proxy default: delete the stored key.
                          void changeDefaultOption({
                            options: { [option.id]: value === '' ? null : value },
                          });
                        }}
                      >
                        <option value="">{t('settings.executors.proxyDefault')}</option>
                        {(option.choices ?? []).map(choice => (
                          <option key={String(choice.value)} value={String(choice.value)}>
                            {choice.displayName}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
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
        <label className="switch agent-enabled-switch" data-testid="agent-enabled-toggle">
          <input
            type="checkbox"
            role="switch"
            checked={enabled}
            disabled={busy || enabledPending}
            onChange={event => { void toggleEnabled(event.target.checked); }}
          />
          <span>{t('agents.detail.enabled')}</span>
        </label>
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
