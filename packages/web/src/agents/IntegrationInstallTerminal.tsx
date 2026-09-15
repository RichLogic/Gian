import { useEffect, useRef } from 'react';
import type { ManagedRuntimeInstallProgress } from '@gian/shared';
import { useT } from '../i18n/index.js';

export interface IntegrationInstallTerminalState {
  id: string;
  action: 'install' | 'update';
  visible: boolean;
  status: 'running' | 'completed' | 'failed' | 'unknown';
  events: ManagedRuntimeInstallProgress[];
  error: string;
}

/** Keep only the newest byte counter for an active component download while
 * retaining every real stage boundary emitted by the Host. */
export function appendIntegrationInstallProgress(
  events: ManagedRuntimeInstallProgress[],
  progress: ManagedRuntimeInstallProgress,
): ManagedRuntimeInstallProgress[] {
  const next = [...events];
  if (progress.stage === 'runtime-download'
    && (progress.status === 'progress' || progress.status === 'completed')) {
    for (let index = next.length - 1; index >= 0; index -= 1) {
      const previous = next[index]!;
      if (previous.stage !== 'runtime-download'
        || previous.componentId !== progress.componentId
        || previous.version !== progress.version) continue;
      if (previous.status === 'progress') {
        next[index] = progress;
        return next;
      }
      break;
    }
  }
  next.push(progress);
  return next.slice(-100);
}

function formatBytes(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function fill(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, value),
    template,
  );
}

export function IntegrationInstallTerminal({
  terminal,
  onHide,
  onShow,
}: {
  terminal: IntegrationInstallTerminalState;
  onHide: () => void;
  onShow: () => void;
}) {
  const t = useT();
  const outputRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [terminal.events, terminal.status, terminal.error]);

  if (!terminal.visible) {
    return (
      <div className="act-row integration-terminal-reopen">
        <button type="button" className="btn xs secondary"
                data-testid="proxy-install-terminal-show" onClick={onShow}>
          {t('agents.installTerminal.show')}
        </button>
      </div>
    );
  }

  const lines = terminal.events.map(progress => {
    const component = progress.componentId ?? 'Runtime';
    const version = progress.version ?? '';
    const values = { component, version };
    switch (progress.stage) {
      case 'catalog':
        return progress.status === 'completed'
          ? `✓ ${t('agents.installTerminal.catalog.completed')}`
          : `› ${t('agents.installTerminal.catalog.started')}`;
      case 'proxy':
        return progress.status === 'completed'
          ? `✓ ${t('agents.installTerminal.proxy.completed')}`
          : `› ${t('agents.installTerminal.proxy.started')}`;
      case 'runtime-discovery':
        return progress.status === 'completed'
          ? `✓ ${t('agents.installTerminal.discovery.completed')}`
          : `› ${t('agents.installTerminal.discovery.started')}`;
      case 'runtime-plan':
        return progress.status === 'completed'
          ? `✓ ${t('agents.installTerminal.plan.completed')}`
          : `› ${t('agents.installTerminal.plan.started')}`;
      case 'runtime-download': {
        if (progress.status === 'completed') {
          return `✓ ${fill(t('agents.installTerminal.download.completed'), values)}`;
        }
        if (progress.status === 'progress') {
          const received = progress.receivedBytes ?? 0;
          const total = progress.totalBytes ?? 0;
          const percent = total > 0 ? String(Math.min(100, Math.floor((received / total) * 100))) : '0';
          return `↓ ${fill(t('agents.installTerminal.download.progress'), {
            ...values,
            percent,
            received: formatBytes(received),
            total: formatBytes(total),
          })}`;
        }
        return `› ${fill(t('agents.installTerminal.download.started'), values)}`;
      }
      case 'runtime-verify':
        return progress.status === 'completed'
          ? `✓ ${fill(t('agents.installTerminal.verify.completed'), values)}`
          : `› ${fill(t('agents.installTerminal.verify.started'), values)}`;
      case 'combination-verify':
        return progress.status === 'completed'
          ? `✓ ${t('agents.installTerminal.combination.completed')}`
          : `› ${t('agents.installTerminal.combination.started')}`;
      case 'activation':
        return progress.status === 'completed'
          ? `✓ ${t('agents.installTerminal.activation.completed')}`
          : `› ${t('agents.installTerminal.activation.started')}`;
    }
  });
  if (lines.length === 0) lines.push(`› ${t('agents.installTerminal.starting')}`);
  if (terminal.status === 'completed') lines.push(`✓ ${t('agents.installTerminal.success')}`);
  if (terminal.status === 'failed') lines.push(`✕ ${terminal.error || t('agents.installTerminal.failed')}`);
  if (terminal.status === 'unknown') lines.push(`? ${terminal.error || t('agents.installTerminal.unknownHelp')}`);

  return (
    <div className="tty integration-install-terminal" data-testid="proxy-install-terminal"
         data-status={terminal.status}>
      <div className="term-bar">
        <span>{t('agents.installTerminal.title')}</span>
        <span className={`st ${terminal.status === 'completed' ? 'good'
          : terminal.status === 'failed' ? 'bad' : 'warn'}`}>
          <span className="st-dot" />
          {t(`agents.installTerminal.${terminal.status}`)}
        </span>
        <span className="spacer" />
        <button type="button" className="btn xs ghost" onClick={onHide}>
          {t('agents.installTerminal.hide')}
        </button>
      </div>
      <pre ref={outputRef} className="integration-terminal-output" role="log"
           aria-live="polite" aria-label={t('agents.installTerminal.title')}>
        {lines.join('\n')}
      </pre>
    </div>
  );
}
