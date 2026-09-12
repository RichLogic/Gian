/**
 * New Chat page (B4, mockup F11): Workspace + Agent + Doing Task required;
 * name / model / turn config stay optional with catalog-derived defaults.
 * Create waits for the canonical Host session before entering chat.
 */

import { useMemo, useState } from 'react';
import { mutationsEnabled } from '../controller/types.js';
import { useT } from '../i18n/index.js';
import { useRemoteActions, useRemoteState } from './controller-context.js';
import { Icon } from './icons.js';

export function NewChatPage() {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();

  const catalog = state.catalog;
  const presetTaskId = state.view.kind === 'new-chat' ? state.view.presetTaskId : '';

  const [workspaceId, setWorkspaceId] = useState<string>(catalog?.workspaces[0]?.id ?? '');
  const [agentId, setAgentId] = useState<string>('');
  const [taskId, setTaskId] = useState<string>(presetTaskId);
  const [name, setName] = useState('');
  const [model, setModel] = useState<string>('');

  const online = mutationsEnabled(state.connection);
  const creating = Object.values(state.mutations).some(
    (m) => m.phase === 'pending' && m.label === 'session.create',
  );
  const createError = Object.values(state.mutations).find(
    (m) => m.phase === 'failed' && m.label === 'session.create',
  );
  const selectedAgent = catalog?.agents.find((a) => a.id === agentId) ?? null;
  const selectedTask = catalog?.tasks.find((task) => task.id === taskId) ?? null;
  const defaultModel = selectedAgent?.defaults?.model ?? '';
  const canSubmit =
    online &&
    !creating &&
    !state.catalogInvalidated &&
    workspaceId !== '' &&
    selectedTask !== null &&
    selectedAgent !== null &&
    selectedAgent.readiness === 'ready';

  const sessionCap = state.capabilities['session.create'];
  const capDenied = sessionCap && sessionCap.state !== 'supported' && sessionCap.state !== 'offline';

  const agents = useMemo(() => catalog?.agents ?? [], [catalog]);

  return (
    <div className="main-scroll">
      <div className="rw-form" data-testid="new-chat-form">
        {state.catalogInvalidated && (
          <div className="session-banner rw-warn" role="status">
            <Icon name="warning" size={13} />
            <span>{t('newchat.catalogInvalidated')}</span>
            <span className="session-banner-spacer" />
            <button type="button" className="btn xs secondary" onClick={() => actions.refreshCatalog()}>
              {t('newchat.catalogRefresh')}
            </button>
          </div>
        )}
        {!online && (
          <div className="session-banner rw-warn" role="status">
            <Icon name="warning" size={13} />
            <span>{t('newchat.hostOffline')}</span>
          </div>
        )}
        {capDenied && (
          <div className="session-banner rw-danger" role="status">
            <Icon name="warning" size={13} />
            <span>{sessionCap.state}</span>
          </div>
        )}

        <div className="rw-form-row">
          <span className="rw-form-label">
            {t('newchat.workspace')} <span className="req">{t('newchat.required')}</span>
          </span>
          <select
            className="rw-select"
            aria-label={t('newchat.workspace')}
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
          >
            <option value="">—</option>
            {(catalog?.workspaces ?? []).map((ws) => (
              <option key={ws.id} value={ws.id}>{ws.name}</option>
            ))}
          </select>
        </div>

        <div className="rw-form-row">
          <span className="rw-form-label">
            {t('newchat.agent')} <span className="req">{t('newchat.required')}</span>
          </span>
          <div className="segm sm" role="radiogroup" aria-label={t('newchat.agent')}>
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                role="radio"
                aria-checked={agentId === agent.id}
                className={`segm-item${agentId === agent.id ? ' active' : ''}`}
                disabled={agent.readiness !== 'ready'}
                title={agent.readiness !== 'ready' ? t('newchat.agentUnavailable') : agent.name}
                onClick={() => {
                  setAgentId(agent.id);
                  setModel('');
                }}
              >
                {agent.name}
              </button>
            ))}
          </div>
          {selectedAgent && selectedAgent.readiness !== 'ready' && (
            <span className="rw-form-note">{t('newchat.agentUnavailable')}</span>
          )}
        </div>

        <div className="rw-form-row">
          <span className="rw-form-label">
            {t('newchat.task')} <span className="req">{t('newchat.required')}</span>
          </span>
          <select
            className="rw-select"
            aria-label={t('newchat.task')}
            value={taskId}
            onChange={(event) => setTaskId(event.target.value)}
          >
            <option value="">—</option>
            {(catalog?.tasks ?? []).map((task) => (
              <option key={task.id} value={task.id}>{task.name}</option>
            ))}
          </select>
        </div>

        <div className="rw-form-row">
          <span className="rw-form-label">
            {t('newchat.name')} <span className="opt">{t('newchat.optional')}</span>
          </span>
          <input
            className="rw-input"
            aria-label={t('newchat.name')}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="rw-form-row">
          <span className="rw-form-label">
            {t('newchat.model')} <span className="opt">{t('newchat.optional')}</span>
          </span>
          <input
            className="rw-input"
            aria-label={t('newchat.model')}
            placeholder={defaultModel ? t('newchat.modelDefault', { model: defaultModel }) : ''}
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
          <span className="rw-form-note">{t('newchat.modelDefault', { model: defaultModel || '—' })}</span>
        </div>

        {createError && (
          <div className="session-banner rw-danger" role="alert">
            <Icon name="warning" size={13} />
            <span>{t('newchat.failed', { message: createError.errorMessage ?? createError.errorCode ?? '' })}</span>
          </div>
        )}

        <div className="rw-set-row" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
          <button type="button" className="btn sm ghost" onClick={() => actions.backToChat()}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn sm primary"
            disabled={!canSubmit}
            onClick={() =>
              actions.createSession({
                workspaceId,
                agentId,
                taskId,
                name: name.trim() === '' ? undefined : name.trim(),
                model: model.trim() === '' ? undefined : model.trim(),
              })
            }
          >
            {creating ? t('newchat.creating') : t('newchat.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
