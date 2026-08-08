import { useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n/index.js';
import type { ChatPanelTarget } from '../presentation/chat-panel.js';
import {
  projectSessionContext,
  type AgentRunDisplayItem,
} from '../presentation/session-context.js';
import { MarkdownText } from '../transcript/items.js';
import type { TranscriptItem } from '../types.js';

interface Props {
  target: ChatPanelTarget;
  items: TranscriptItem[];
  planText?: string;
  planCompleted?: boolean;
  planStatus?: 'active' | 'paused' | 'completed';
  planTurn?: number;
  onClose: () => void;
}

export function ChatContextPanel({
  target,
  items,
  planText,
  planCompleted,
  planStatus,
  planTurn,
  onClose,
}: Props) {
  const t = useT();
  const context = useMemo(
    () => projectSessionContext({
      items,
      planText,
      planCompleted,
      planStatus,
      planTurn,
      sessionId: target.sessionId,
      includeAgentHistory: true,
      includePlanHistory: true,
    }),
    [items, planText, planCompleted, planStatus, planTurn, target.sessionId],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const agent = target.kind === 'agent'
    ? context.agents.find(item => item.id === target.id) ?? null
    : null;
  const plan = target.kind === 'plan' ? context.plan : null;
  const title = target.kind === 'plan'
    ? t('chatPanel.plan.title')
    : t('chatPanel.agent.title');

  return (
    <aside className="chat-context-panel" aria-label={title}>
      <header className="chat-context-head">
        <div>
          <span className="chat-context-owner">{t('chatPanel.owner')}</span>
          <h2>{title}</h2>
        </div>
        <button
          type="button"
          className="chat-context-close"
          aria-label={t('common.close')}
          title={t('common.close')}
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </header>

      <div className="chat-context-scroll">
        {plan && (
          <section className="chat-context-plan approval-plan-md">
            {plan.totalSteps > 0 && (
              <div className="chat-context-progress">
                <span>{t('chatPanel.plan.progress')}</span>
                <strong>{plan.completedSteps}/{plan.totalSteps}</strong>
              </div>
            )}
            <MarkdownText>{plan.markdown}</MarkdownText>
          </section>
        )}

        {agent && <AgentDetail agent={agent} />}

        {!plan && !agent && (
          <div className="chat-context-empty">{t('chatPanel.unavailable')}</div>
        )}
      </div>
    </aside>
  );
}

function AgentDetail({ agent }: { agent: AgentRunDisplayItem }) {
  const t = useT();
  const [, setTick] = useState(0);
  useEffect(() => {
    if (agent.status !== 'running') return;
    const timer = window.setInterval(() => setTick(value => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [agent.status]);

  const providerName =
    agent.provider === 'claude' ? 'Claude'
    : agent.provider === 'codex' ? 'Codex'
    : 'Kimi';
  const statusLabel =
    agent.status === 'running' ? t('coding.status.running')
    : agent.status === 'interrupted' ? t('coding.status.interrupted')
    : agent.status === 'error' ? t('coding.status.error')
    : t('coding.status.done');
  const prompt = agentPrompt(agent.input);
  const elapsedTo = agent.completedAt
    ?? (agent.status === 'running' ? Date.now() : agent.updatedAt);

  return (
    <article className="chat-agent-detail">
      <div className="chat-agent-summary">
        <div>
          <div className="chat-agent-kicker">
            <span className="chat-agent-provider" data-provider={agent.provider}>
              <span aria-hidden />
              {providerName}
            </span>
            <span className={`chat-agent-state chat-agent-state--${agent.status}`}>
              {statusLabel}
            </span>
          </div>
          <h3>{agent.description}</h3>
        </div>
      </div>

      <dl className="chat-agent-meta">
        {agent.agentType && (
          <Meta label={t('chatPanel.agent.role')} value={agent.agentType} />
        )}
        {agent.model && (
          <Meta label={t('chatPanel.agent.model')} value={agent.model} />
        )}
        {agent.background !== undefined && (
          <Meta
            label={t('chatPanel.agent.execution')}
            value={t(agent.background
              ? 'chatPanel.agent.background'
              : 'chatPanel.agent.foreground')}
          />
        )}
        <Meta
          label={t('chatPanel.agent.duration')}
          value={formatDuration(Math.max(0, elapsedTo - agent.startedAt))}
        />
        {agent.agentId && (
          <Meta label={t('chatPanel.agent.agentId')} value={agent.agentId} mono />
        )}
        {agent.taskId && (
          <Meta label={t('chatPanel.agent.taskId')} value={agent.taskId} mono />
        )}
      </dl>

      {prompt && (
        <section className="chat-agent-section">
          <h4>{t('chatPanel.agent.prompt')}</h4>
          <div className="chat-agent-markdown">
            <MarkdownText>{prompt}</MarkdownText>
          </div>
        </section>
      )}

      <section className="chat-agent-section">
        <h4>
          {agent.status === 'error' || agent.status === 'interrupted'
            ? t('chatPanel.agent.error')
            : t('chatPanel.agent.result')}
        </h4>
        {agent.output && agent.status !== 'running' ? (
          <div className="chat-agent-markdown">
            <MarkdownText>{agent.output}</MarkdownText>
          </div>
        ) : (
          <p className="chat-agent-waiting">
            {agent.status === 'running'
              ? t('chatPanel.agent.waiting')
              : t('chatPanel.agent.noResult')}
          </p>
        )}
      </section>
    </article>
  );
}

function agentPrompt(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  for (const key of ['prompt', 'description', 'task', 'message']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function Meta({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined} title={value}>{value}</dd>
    </div>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
         stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}
