import { Fragment, useEffect, useState } from 'react';
import { DEFAULT_TRANSLATION_PREFERENCES, TRANSLATION_LANGUAGES, type ConfigOption, type SystemConfig, type UserAgentStatus } from '@gian/shared';
import { loadAgents } from '../api.js';
import { useT } from '../i18n/index.js';
import { translationCatalog } from '../operations/translation.js';

export function SettingsTranslation({ config, onPatch }: { config: SystemConfig; onPatch: (patch: Partial<SystemConfig>) => void }) {
  const t = useT();
  const value = config.translation ?? DEFAULT_TRANSLATION_PREFERENCES;
  const [agents, setAgents] = useState<UserAgentStatus[]>([]);
  const [models, setModels] = useState<ConfigOption['choices']>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let alive = true;
    void loadAgents().then(items => { if (alive) setAgents(items.filter(agent => !agent.id.startsWith('remote:'))); }).catch(error => { if (alive) setError(String(error)); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    let alive = true;
    setModels([]); setError('');
    const agent = agents.find(agent => agent.id === value.agent_id);
    if (!agent) return;
    setLoading(true);
    void translationCatalog(agent.pluginId, agent.id).then(catalog => {
      if (!alive) return;
      if (!catalog.configOptions.some(option => option.id === 'gian.translation')) {
        setError(t('translation.unsupported')); return;
      }
      setModels(catalog.configOptions.find(option => option.role === 'model')?.choices ?? []);
    }).catch(error => { if (alive) setError(String(error)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [agents, value.agent_id, t]);
  return <>
    <h4 className="s2-sectiontitle">{t('translation.title')}</h4>
    <dl className="kv-grid translation-settings">
      {(['sending_language', 'reading_language'] as const).map(key => <Fragment key={key}>
        <dt>{t(`translation.${key}`)}</dt>
        <dd><select className="select" aria-label={t(`translation.${key}`)} value={value[key]}
          onChange={event => onPatch({ translation: { ...value, [key]: event.target.value } })}>
          {TRANSLATION_LANGUAGES.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select></dd>
      </Fragment>)}
      <dt>{t('translation.agent')}</dt>
      <dd><select className="select" aria-label={t('translation.agent')} value={value.agent_id}
        onChange={event => onPatch({ translation: { ...value, agent_id: event.target.value, model: '' } })}>
        <option value="">{t('translation.chooseAgent')}</option>
        {value.agent_id && !agents.some(agent => agent.id === value.agent_id) && <option value={value.agent_id}>{t('translation.agentMissing')}</option>}
        {agents.map(agent => <option key={agent.id} value={agent.id} disabled={agent.enabled === false || !agent.ready}>{agent.name}</option>)}
      </select></dd>
      <dt>{t('translation.model')}</dt>
      <dd><select className="select" aria-label={t('translation.model')} value={value.model} disabled={loading || !models?.length}
        onChange={event => onPatch({ translation: { ...value, model: event.target.value } })}>
        <option value="">{t(loading ? 'translation.loadingModels' : 'translation.chooseModel')}</option>
        {value.model && !models?.some(model => model.value === value.model) && <option value={value.model}>{value.model}</option>}
        {models?.map(model => <option key={String(model.value)} value={String(model.value)}>{model.displayName}</option>)}
      </select></dd>
    </dl>
    {error && <p role="alert" className="translation-error">{error}</p>}
  </>;
}
