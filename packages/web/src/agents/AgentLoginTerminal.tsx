import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_TERMINAL_PREFERENCES, type TerminalPreferences } from '@gian/shared';
import { Terminal } from '../components/Terminal.js';
import { makeWorkbenchWire } from '../components/terminal-wire.js';
import { useT } from '../i18n/index.js';
import { useOperationDispatch } from '../operations/use-operations.js';
import type { GianWs } from '../ws.js';

export function AgentLoginTerminal({
  ws,
  agentId,
  agentName,
  homePath,
  termId,
  preferences = DEFAULT_TERMINAL_PREFERENCES,
  onClose,
}: {
  ws: GianWs;
  agentId: string;
  agentName: string;
  homePath: string;
  termId: string;
  preferences?: TerminalPreferences;
  onClose: () => void;
}) {
  const t = useT();
  const dispatch = useOperationDispatch();
  useEffect(() => () => {
    dispatch('term.close', { termId });
  }, [dispatch, termId]);

  return createPortal(
    <div className="ws-dialog-backdrop">
      <div className="ws-dialog agent-login-dialog" role="dialog" aria-modal="true"
           aria-label={t('agents.detail.loginTerminal').replace('{name}', agentName)}>
        <header className="ws-dialog-head agent-login-head">
          <div>
            <h2 className="ws-dialog-title">{t('agents.detail.loginTerminal').replace('{name}', agentName)}</h2>
            <p className="s2-help">{t('agents.detail.loginHelp').replace('{path}', homePath)}</p>
          </div>
          <button type="button" className="btn sm ghost" onClick={onClose}>
            {t('agents.detail.loginClose')}
          </button>
        </header>
        <div className="agent-login-tty" data-testid="agent-login-terminal">
          <Terminal
            instanceKey={termId}
            preferences={preferences}
            wire={makeWorkbenchWire(ws, termId, {
              target: { kind: 'agent_cli', agent_id: agentId, action: 'login' },
            }, dispatch)}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
