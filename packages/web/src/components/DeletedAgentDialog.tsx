import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { resolvePluginIdInput, type Session, type UserAgentStatus } from '@gian/shared';
import { AgentLogo } from './AgentLogo.js';
import { useT } from '../i18n/index.js';

export function sameProxyAgents(
  session: Pick<Session, 'executor' | 'proxy_plugin_id'>,
  agents: UserAgentStatus[],
): UserAgentStatus[] {
  const pluginId = resolvePluginIdInput(session.proxy_plugin_id ?? session.executor)
    ?? session.proxy_plugin_id
    ?? session.executor;
  return agents.filter(agent => agent.pluginId === pluginId);
}

export function DeletedAgentDialog({
  session,
  agents,
  busy,
  sessionBusy,
  error,
  onSelect,
  onOpenAgents,
  onLater,
}: {
  session: Session;
  agents: UserAgentStatus[];
  busy: boolean;
  sessionBusy: boolean;
  error: string;
  onSelect: (agentId: string) => void;
  onOpenAgents?: () => void;
  onLater: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement>(null);
  const candidates = useMemo(() => sameProxyAgents(session, agents), [agents, session]);
  const proxyName = resolvePluginIdInput(session.proxy_plugin_id ?? session.executor)
    ?? session.proxy_plugin_id
    ?? session.executor;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const first = dialogRef.current?.querySelector<HTMLElement>('button:not([disabled])');
    (first ?? dialogRef.current)?.focus();
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onLater();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [],
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, onLater]);

  return createPortal(
    <div className="confirm-overlay" data-testid="deleted-agent-overlay">
      <div
        ref={dialogRef}
        className="confirm-modal deleted-agent-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-busy={busy}
        aria-labelledby="deleted-agent-title"
        aria-describedby="deleted-agent-description"
        tabIndex={-1}
      >
        <h2 className="confirm-title" id="deleted-agent-title">
          {t('session.agentDeleted.title')}
        </h2>
        <p className="confirm-msg" id="deleted-agent-description">
          {t('session.agentDeleted.description')
            .replace('{name}', session.agent_name ?? session.agent_id ?? '')
            .replace('{proxy}', proxyName)}
        </p>

        {candidates.length > 0 ? (
          <div className="deleted-agent-list" data-testid="deleted-agent-list">
            {candidates.map(agent => (
              <button
                key={agent.id}
                type="button"
                className="mp-row deleted-agent-option"
                data-testid={`deleted-agent-option-${agent.id}`}
                disabled={busy || sessionBusy}
                onClick={() => onSelect(agent.id)}
              >
                <AgentLogo
                  proxy={agent.proxy}
                  fallback={agent.name}
                  size={28}
                />
                <span className="mp-row-body">
                  <span className="mp-row-title">{agent.name}</span>
                  <span className="mp-row-sub mono">{agent.home?.path ?? proxyName}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="deleted-agent-empty" data-testid="deleted-agent-empty">
            {t('session.agentDeleted.empty').replace('{proxy}', proxyName)}
          </p>
        )}

        {sessionBusy && (
          <p className="deleted-agent-busy" role="status">
            {t('session.agentDeleted.busy')}
          </p>
        )}
        {error && <p className="spaces-error" role="alert">{error}</p>}

        <div className="confirm-actions">
          <button type="button" className="btn ghost" disabled={busy} onClick={onLater}>
            {t('session.agentDeleted.later')}
          </button>
          {candidates.length === 0 && onOpenAgents && (
            <button type="button" className="btn primary" disabled={busy} onClick={onOpenAgents}>
              {t('session.agentDeleted.openAgents')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
