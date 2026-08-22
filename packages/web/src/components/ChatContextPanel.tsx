import { useEffect, useMemo, useState } from 'react';
import type { Session, SideChatInfo } from '@gian/shared';
import { useT } from '../i18n/index.js';
import type { ChatPanelTarget } from '../presentation/chat-panel.js';
import type { ActionControlState } from './action-gating.js';
import { SideChatDock } from './SideChatDock.js';
import {
  projectSessionContext,
  type AgentRunDisplayItem,
} from '../presentation/session-context.js';
import { traceItemDurationMs } from '../trace/model.js';
import { EvidenceChip, formatTraceClock, StatusBadge } from '../trace/TraceView.js';
import type { TraceItem } from '../trace/types.js';
import { formatElapsed, MarkdownText } from '../transcript/items.js';
import type { TranscriptItem } from '../types.js';

interface Props {
  target: ChatPanelTarget;
  items: TranscriptItem[];
  planText?: string;
  planCompleted?: boolean;
  planStatus?: 'active' | 'paused' | 'completed';
  planTurn?: number;
  /** Side Chat surface bundle (proposal §10.5), required when
   *  `target.kind === 'sidechat'`: the parent session, its read-model
   *  records, the projected transcript/echo stores, the create control's
   *  gating state, and the authoritative-removal callback. */
  sideChat?: {
    parent: Session;
    sideChats: SideChatInfo[];
    items: Record<string, TranscriptItem[]>;
    control: ActionControlState | null;
    onClosed: (sidechatId: string) => void;
  } | null;
  onClose: () => void;
}

export function ChatContextPanel({
  target,
  items,
  planText,
  planCompleted,
  planStatus,
  planTurn,
  sideChat,
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

  // Side Chat surface (proposal §10.5): the whole panel is the dock — no
  // generic detail header; the dock renders a single terminal-style tab
  // strip (same visual language as the workbench terminal). Panel close is
  // the dock-rail toggle / Escape, like every other panel-2 surface.
  if (target.kind === 'sidechat') {
    return (
      <aside className="chat-context-panel sidechat" aria-label={t('sidechat.title')}>
        {sideChat ? (
          <SideChatDock
            parent={sideChat.parent}
            sideChats={sideChat.sideChats}
            items={sideChat.items}
            control={sideChat.control}
            onClosed={sideChat.onClosed}
          />
        ) : (
          <div className="chat-context-empty">{t('chatPanel.unavailable')}</div>
        )}
      </aside>
    );
  }

  const agent = target.kind === 'agent'
    ? context.agents.find(item => item.id === target.id) ?? null
    : null;
  const plan = target.kind === 'plan' ? context.plan : null;
  const traceItem = target.kind === 'trace-item' ? target.item : null;
  const detail = target.kind === 'transcript-detail' ? target : null;
  const title = target.kind === 'plan'
    ? t('chatPanel.plan.title')
    : target.kind === 'agent'
      ? t('chatPanel.agent.title')
      : target.kind === 'trace-item'
        ? target.item.title
        : target.title;

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

        {traceItem && <TraceItemDetail item={traceItem} />}

        {detail && <pre className="chat-context-detail">{detail.text}</pre>}

        {!plan && !agent && !traceItem && !detail && (
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

/** Panel-2 detail for one trace item — the fields the old inline
 *  TraceDetail region showed, on the chat-context Meta/dl pattern. */
function TraceItemDetail({ item }: { item: TraceItem }) {
  const t = useT();
  const duration = traceItemDurationMs(item);
  return (
    <article className="chat-trace-detail" data-testid="chat-trace-detail">
      <div className="chat-agent-kicker">
        <span className={`trace-kind ${item.kind}`}>{t(`trace.kind.${item.kind}`)}</span>
      </div>
      <dl className="chat-agent-meta">
        <div>
          <dt>{t('trace.detail.evidence')}</dt>
          <dd><EvidenceChip evidence={item.evidence} /></dd>
        </div>
        <div>
          <dt>{t('trace.detail.status')}</dt>
          <dd>{item.status ? <StatusBadge status={item.status} /> : '—'}</dd>
        </div>
        <Meta label={t('trace.detail.started')} value={formatTraceClock(item.at)} mono />
        {item.endAt && (
          <Meta label={t('trace.detail.ended')} value={formatTraceClock(item.endAt)} mono />
        )}
        {duration !== undefined && (
          <Meta label={t('trace.detail.duration')} value={formatElapsed(duration)} />
        )}
        {item.correlationId && (
          <Meta label={t('trace.detail.correlation')} value={item.correlationId} mono />
        )}
        <Meta label={t('trace.detail.sourceEvents')} value={String(item.sourceEventIds.length)} />
      </dl>
      {item.kind === 'request' ? (
        <TraceRequestPayload item={item} />
      ) : item.detail !== undefined ? (
        <pre className="chat-context-detail">{JSON.stringify(item.detail, null, 2)}</pre>
      ) : (
        <p className="chat-agent-waiting">{t('trace.detail.empty')}</p>
      )}
    </article>
  );
}

function TraceRequestPayload({ item }: { item: TraceItem }) {
  const t = useT();
  const detail = asRecord(item.detail);
  const model = asRecord(detail.model);
  const parameters = asRecord(detail.parameters);
  const systemPrompt = asRecord(detail.systemPrompt);
  const context = asRecord(detail.context);
  const artifact = asRecord(detail.artifact);
  const tools = Array.isArray(detail.tools)
    ? detail.tools
      .map(tool => asRecord(tool))
      .filter(tool => typeof tool.name === 'string' && tool.name.length > 0)
    : [];
  const reason = typeof detail.reason === 'string' && detail.reason
    ? detail.reason
    : item.summary ?? '';
  const reasonKey = reason === 'initial' || reason === 'resume' || reason === 'change'
    ? (`trace.request.reason.${reason}` as const)
    : null;
  const provider = typeof model.provider === 'string' ? model.provider : '';
  const modelId = typeof model.id === 'string' ? model.id : '';
  const displayName = typeof model.displayName === 'string' ? model.displayName : '';
  const contextWindow = typeof context.window === 'number' ? context.window : undefined;
  const artifactPath = typeof artifact.path === 'string' ? artifact.path : '';
  const truncated = detail.truncated === true || systemPrompt.truncated === true;
  // Parameter values are opaque scalars — displayed verbatim, never interpreted.
  const parameterEntries = Object.entries(parameters)
    .map(([key, value]) => [key, String(value)] as const);
  return (
    <div className="trace-request-card" data-testid="trace-request-card">
      <dl className="chat-agent-meta">
        <Meta
          label={t('trace.request.model')}
          value={displayName || modelId || item.title}
        />
        {provider && <Meta label={t('trace.request.provider')} value={provider} />}
        {modelId && <Meta label={t('trace.request.modelId')} value={modelId} mono />}
        <div>
          <dt>{t('trace.request.reason')}</dt>
          <dd>
            <span
              className="trace-request-reason"
              data-testid="trace-request-reason"
              data-reason={reason}
            >
              {reasonKey ? t(reasonKey) : reason}
            </span>
          </dd>
        </div>
        {contextWindow !== undefined && (
          <Meta
            label={t('trace.request.contextWindow')}
            value={String(contextWindow)}
            mono
          />
        )}
        {artifactPath && (
          <Meta label={t('trace.request.artifact')} value={artifactPath} mono />
        )}
      </dl>
      {truncated && (
        <p className="trace-request-truncated" role="status" data-testid="trace-request-truncated">
          {t('trace.request.truncated')}
        </p>
      )}
      {parameterEntries.length > 0 && (
        <div className="trace-request-parameters">
          <span className="trace-request-label">{t('trace.request.parameters')}</span>
          <div className="trace-request-chips" data-testid="trace-request-parameters">
            {parameterEntries.map(([key, value]) => (
              <span className="trace-request-chip" key={key} title={`${key}: ${value}`}>
                {key}: {value}
              </span>
            ))}
          </div>
        </div>
      )}
      {typeof systemPrompt.text === 'string' && (
        <details className="trace-request-prompt">
          <summary>{t('trace.request.systemPrompt')}</summary>
          <pre>{systemPrompt.text}</pre>
        </details>
      )}
      {tools.length > 0 && (
        <details className="trace-request-tools">
          <summary>{t('trace.request.tools')}</summary>
          <ul>
            {tools.map(tool => (
              <li key={String(tool.name)}>
                <code>{String(tool.name)}</code>
                {typeof tool.description === 'string' && tool.description
                  ? ` — ${tool.description}`
                  : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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
