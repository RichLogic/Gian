import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n/index.js';
import { ChatPanelOpenContext } from '../presentation/chat-panel.js';
import { projectSessionContext, type AgentRunDisplayItem } from '../presentation/session-context.js';
import type { TranscriptItem } from '../types.js';
import { MarkdownText } from '../transcript/items.js';
import { useUnderbarPanelController } from './UnderbarPanelGroup.js';
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
  planStatus,
  planTurn,
  sessionId,
}: {
  items: TranscriptItem[];
  /** Latest streamed plan text from the active executor. */
  planText?: string;
  /** Successful turn-end has confirmed that every streamed step is complete. */
  planCompleted?: boolean;
  planStatus?: 'active' | 'paused' | 'completed';
  planTurn?: number;
  sessionId: string;
}) {
  const t = useT();
  const openChatPanel = useContext(ChatPanelOpenContext);
  const panelController = useUnderbarPanelController();
  const [standalonePanel, setStandalonePanel] = useState<'plan' | 'agent' | null>(null);
  const planOpen = panelController
    ? panelController.openPanel === 'plan'
    : standalonePanel === 'plan';
  const agentsOpen = panelController
    ? panelController.openPanel === 'agent'
    : standalonePanel === 'agent';
  const groupedClosePanel = panelController?.closePanel;
  const groupedTogglePanel = panelController?.togglePanel;
  const closePanels = useCallback(() => {
    if (groupedClosePanel) groupedClosePanel();
    else setStandalonePanel(null);
  }, [groupedClosePanel]);
  const togglePanel = useCallback((panel: 'plan' | 'agent') => {
    if (groupedTogglePanel) groupedTogglePanel(panel);
    else setStandalonePanel(current => current === panel ? null : panel);
  }, [groupedTogglePanel]);
  const context = useMemo(
    () => projectSessionContext({
      items,
      planText: planText,
      planCompleted,
      planStatus,
      planTurn,
      sessionId,
    }),
    [items, planText, planCompleted, planStatus, planTurn, sessionId],
  );

  useEffect(() => {
    setStandalonePanel(null);
  }, [sessionId]);

  useEffect(() => {
    if ((planOpen && !context.plan) || (agentsOpen && context.agents.length === 0)) {
      closePanels();
    }
  }, [agentsOpen, closePanels, context.agents.length, context.plan, planOpen]);

  if (!context.plan && context.agents.length === 0) return null;

  const visibleAgents = context.agents.slice(0, 8);
  const hiddenAgentCount = Math.max(0, context.agents.length - visibleAgents.length);
  const agentStateClass = context.failedAgents > 0
    ? 'context-chip-dot--error'
    : context.runningAgents > 0
      ? 'context-chip-dot--running'
      : context.interruptedAgents > 0
        ? 'context-chip-dot--interrupted'
      : 'context-chip-dot--done';
  const agentProgress = formatAgentProgress(context);

  return (
    <div className="context-strip-shell">
      {planOpen && context.plan && (
        <section
          id={`context-plan-${sessionId}`}
          className="context-plan-panel"
          aria-label="Plan"
          data-underbar-panel-interactive
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
                onClick={closePanels}
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
        <section
          className="context-agent-panel"
          aria-label={t('transcript.agentRuns')}
          data-underbar-panel-interactive
        >
          <header className="context-agent-panel-head">
            <div>
              <strong>{t('transcript.agentRuns')}</strong>
              <span>
                {agentProgress}
              </span>
            </div>
            <button
              type="button"
              className="context-panel-close"
              aria-label={t('common.close')}
              title={t('common.close')}
              onClick={closePanels}
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
                  closePanels();
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
            data-underbar-panel-interactive
            onClick={() => togglePanel('plan')}
            title={t('transcript.planViewLatest')}
          >
            <span className="plan-chip-label">Plan</span>
            {context.plan.totalSteps > 0 && (
              <span className="context-chip-meta">
                {context.plan.completedSteps}/{context.plan.totalSteps}
              </span>
            )}
            <span className="context-chip-meta">
              {planStatusLabel(context.plan.status, t)}
            </span>
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
            data-underbar-panel-interactive
            onClick={() => togglePanel('agent')}
            title={t('transcript.agentViewRuns')}
          >
            <span>{t('transcript.agent')}</span>
            <span className="context-chip-meta">{agentProgress}</span>
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
    agent.status === 'interrupted' ? t('coding.status.interrupted') :
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

function planDotClass(status: 'active' | 'paused' | 'completed' | 'awaiting-review' | 'accepted' | 'revision-requested') {
  if (status === 'awaiting-review') return 'plan-chip-dot--pending';
  if (status === 'revision-requested') return 'plan-chip-dot--declined';
  if (status === 'paused') return 'plan-chip-dot--paused';
  if (status === 'active') return 'plan-chip-dot--active';
  return 'plan-chip-dot--accepted';
}

function planStatusLabel(status: 'active' | 'paused' | 'completed' | 'awaiting-review' | 'accepted' | 'revision-requested', t: (key: string) => string) {
  if (status === 'active') return t('coding.status.running');
  if (status === 'paused') return t('coding.status.paused');
  if (status === 'completed') return t('coding.status.done');
  if (status === 'awaiting-review') return t('coding.status.awaitingApproval');
  if (status === 'revision-requested') return t('transcript.planRevisionRequested');
  return t('transcript.planAccepted');
}

function formatAgentProgress(
  context: ReturnType<typeof projectSessionContext>,
): string {
  return `${context.completedAgents}/${context.agents.length}`;
}

function jumpToAgent(agentId: string) {
  const anchors = document.querySelectorAll<HTMLElement>('[data-agent-id]');
  const target = [...anchors].find(anchor => anchor.dataset.agentId === agentId);
  target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
