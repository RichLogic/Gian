import { useContext, useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n/index.js';
import { ChatPanelOpenContext } from '../presentation/chat-panel.js';
import { projectSessionContext, type AgentRunDisplayItem } from '../presentation/session-context.js';
import type { TranscriptItem } from '../types.js';
import { MarkdownText } from '../transcript/items.js';
import '../styles/context-strip.css';

/**
 * Persistent context strip above the composer.
 *
 * Plan and subagent events still keep their compact transcript anchors. This
 * component projects only their durable page-level state: the latest plan and
 * the current/recent agent runs. It intentionally does not turn every native
 * CLI event into another card.
 */
export function PlanChip({
  items,
  planText,
  planCompleted,
  sessionId,
}: {
  items: TranscriptItem[];
  /** Latest streamed plan text from the active executor. */
  planText?: string;
  /** Successful turn-end has confirmed that every streamed step is complete. */
  planCompleted?: boolean;
  sessionId: string;
}) {
  const t = useT();
  const openChatPanel = useContext(ChatPanelOpenContext);
  const [planOpen, setPlanOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const context = useMemo(
    () => projectSessionContext({
      items,
      planText: planText,
      planCompleted,
      sessionId,
    }),
    [items, planText, planCompleted, sessionId],
  );

  useEffect(() => {
    setPlanOpen(false);
    setAgentsOpen(false);
  }, [sessionId]);

  useEffect(() => {
    if (!context.plan) setPlanOpen(false);
    if (context.agents.length === 0) setAgentsOpen(false);
  }, [context.plan, context.agents.length]);

  if (!context.plan && context.agents.length === 0) return null;

  const visibleAgents = context.agents.slice(0, 8);
  const hiddenAgentCount = Math.max(0, context.agents.length - visibleAgents.length);
  const agentStateClass = context.failedAgents > 0
    ? 'context-chip-dot--error'
    : context.runningAgents > 0
      ? 'context-chip-dot--running'
      : 'context-chip-dot--done';

  return (
    <div className="context-strip-shell">
      {planOpen && context.plan && (
        <section
          id={`context-plan-${sessionId}`}
          className="context-plan-panel"
          aria-label="Plan"
        >
          <header className="context-plan-panel-head">
            <div>
              <strong>Plan</strong>
              {context.plan.totalSteps > 0 && (
                <span>
                  {context.plan.completedSteps}/{context.plan.totalSteps}
                </span>
              )}
            </div>
            <div className="context-panel-actions">
              <button
                type="button"
                className="context-panel-close"
                aria-label={t('common.close')}
                title={t('common.close')}
                onClick={() => setPlanOpen(false)}
              >
                <span aria-hidden>&times;</span>
              </button>
            </div>
          </header>
          <div className="context-plan-body approval-plan-md">
            <MarkdownText>{context.plan.markdown}</MarkdownText>
          </div>
        </section>
      )}

      {agentsOpen && (
        <section className="context-agent-panel" aria-label={t('transcript.agentRuns')}>
          <header className="context-agent-panel-head">
            <div>
              <strong>{t('transcript.agentRuns')}</strong>
              <span>
                {context.runningAgents > 0
                  ? `${context.runningAgents} ${t('coding.status.running').toLowerCase()}`
                  : `${context.agents.length} ${t('coding.status.done').toLowerCase()}`}
              </span>
            </div>
            <button
              type="button"
              className="context-panel-close"
              aria-label={t('common.close')}
              title={t('common.close')}
              onClick={() => setAgentsOpen(false)}
            >
              <span aria-hidden>&times;</span>
            </button>
          </header>
          <div className="context-agent-list">
            {visibleAgents.map(agent => (
              <AgentRunRow
                key={agent.id}
                agent={agent}
                onSelect={() => {
                  setAgentsOpen(false);
                  if (openChatPanel) openChatPanel({ kind: 'agent', id: agent.id });
                  else jumpToAgent(agent.id);
                }}
              />
            ))}
          </div>
          {hiddenAgentCount > 0 && (
            <div className="context-agent-more">
              +{hiddenAgentCount} {t('transcript.agentPrevious')}
            </div>
          )}
        </section>
      )}

      <div className="context-strip" aria-label={t('transcript.sessionContext')}>
        {context.plan && (
          <button
            type="button"
            className="plan-chip"
            aria-expanded={planOpen}
            aria-controls={`context-plan-${sessionId}`}
            onClick={() => {
              setPlanOpen(open => !open);
              setAgentsOpen(false);
            }}
            title={t('transcript.planViewLatest')}
          >
            <span className="plan-chip-label">Plan</span>
            {context.plan.totalSteps > 0 && (
              <span className="context-chip-meta">
                {context.plan.completedSteps}/{context.plan.totalSteps}
              </span>
            )}
            <span
              className={`plan-chip-dot ${planDotClass(context.plan.status)}`}
              aria-hidden
            />
          </button>
        )}

        {context.agents.length > 0 && (
          <button
            type="button"
            className="context-chip context-agent-trigger"
            aria-expanded={agentsOpen}
            onClick={() => {
              setAgentsOpen(open => !open);
              setPlanOpen(false);
            }}
            title={t('transcript.agentViewRuns')}
          >
            <span>{t('transcript.agent')}</span>
            <span className="context-chip-count">{context.agents.length}</span>
            <span className={`context-chip-dot ${agentStateClass}`} aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}

function AgentRunRow({
  agent,
  onSelect,
}: {
  agent: AgentRunDisplayItem;
  onSelect: () => void;
}) {
  const t = useT();
  const providerName =
    agent.provider === 'claude' ? 'Claude' :
    agent.provider === 'codex' ? 'Codex' :
    'Kimi';
  const statusLabel =
    agent.status === 'running' ? t('coding.status.running') :
    agent.status === 'error' ? t('coding.status.error') :
    t('coding.status.done');
  const detail = [agent.agentType, agent.model].filter(Boolean).join(' · ');

  return (
    <button
      type="button"
      className="context-agent-row"
      data-provider={agent.provider}
      onClick={onSelect}
      title={t('transcript.agentOpen')}
    >
      <span className="context-provider-mark" aria-hidden />
      <span className="context-agent-copy">
        <span className="context-agent-title">
          <strong>{providerName}</strong>
          {detail && <span>{detail}</span>}
        </span>
        <span className="context-agent-description">{agent.description}</span>
        {agent.output && agent.status !== 'running' && (
          <span className="context-agent-output">{agent.output}</span>
        )}
      </span>
      <span className={`context-agent-status context-agent-status--${agent.status}`}>
        <span aria-hidden />
        {statusLabel}
      </span>
    </button>
  );
}

function planDotClass(status: 'active' | 'awaiting-review' | 'accepted' | 'revision-requested') {
  if (status === 'awaiting-review') return 'plan-chip-dot--pending';
  if (status === 'revision-requested') return 'plan-chip-dot--declined';
  if (status === 'active') return 'plan-chip-dot--active';
  return 'plan-chip-dot--accepted';
}

function jumpToAgent(agentId: string) {
  const anchors = document.querySelectorAll<HTMLElement>('[data-agent-id]');
  const target = [...anchors].find(anchor => anchor.dataset.agentId === agentId);
  target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
