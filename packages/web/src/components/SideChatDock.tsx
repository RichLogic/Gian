/**
 * Side Chat surface (gian.proxy/2.0 proposal §10.5,
 * `docs/proposals/gian-proxy-v2-ui-bridge.md`) — panel-2 content mounted by
 * `ChatContextPanel` for the `sidechat` chat-panel kind. The entry point is
 * the session-scoped button on the right Dock rail; this component is the
 * surface itself:
 *
 * - a chip strip switching between the ACTIVE parent session's open Side
 *   Chats (multiple are allowed, each with an independent transcript and
 *   pending state), plus the gated "new Side Chat" affordance;
 * - the selected Side Chat's transcript (shared `Transcript` pipeline — a
 *   Side Chat renders whatever the runtime produces, never a fake
 *   tool-less/read-only mode) and the standard fixed-config composer;
 * - the §10.5.3 recovery flow (resume once per page lifetime, stable
 *   recovering state, cannot-continue on failure) and the §10.5.4 close
 *   flow (4-clause confirm → closing, never back to open, removal only on
 *   authoritative success).
 *
 * Transcript/pending data flow (Host contract): the Host broadcasts complete
 * public snapshots (`sidechat:created`/`sidechat:updated`,
 * `state_sync.sidechats`); use-app-socket folds them through
 * `presentation/sidechat-events.ts` into `itemsBySidechat` and merges live
 * optimistic echoes. Turn-running state derives from the snapshot's `state`
 * (running/waiting_interaction) plus any pending echo — there is no separate
 * event-frame pending channel.
 *
 * Wire-level notes (gian.proxy/2.0): `message:send` / `session:stop` /
 * `approval:resolve` with `session_id = sidechatId` map to turn.start /
 * turn.interrupt / interaction.respond on the Side Chat route — the only
 * Action methods §10.5.1 allows there. Session-config methods are NOT sent
 * (Turn-configurable restricted composer; see `sideChatComposerSession`).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApprovalDecision, ConfigValue, Session, SideChatInfo } from '@gian/shared';

import { useT } from '../i18n/index.js';
import { confirm as confirmDialog, toast } from '../feedback.js';
import { dispatchMessageSend } from '../operations/message.js';
import { sidechatEntityKey } from '../operations/sidechat.js';
import {
  useOperationDispatch,
  useOperationPending,
  useOperationRun,
  useOverlayField,
  usePendingOperations,
} from '../operations/use-operations.js';
import type { ApprovalActionContext, TranscriptItem } from '../types.js';
import { Transcript } from '../transcript/Transcript.js';
import { Composer } from './Composer.js';
import {
  sideChatCloseConfirmMessage,
  sideChatComposerSession,
  sideChatLabel,
} from '../presentation/sidechat.js';
import type { ActionControlState } from './action-gating.js';

// ─── Inline icons (same 24-grid / 1.5px stroke idiom as CodingView) ───────
function SvgIcon({ d, size = 16, stroke = 1.5 }: { d: string; size?: number; stroke?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
         strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d.split(' M').map((seg, i) => (
        <path key={i} d={i === 0 ? seg : `M${seg}`} />
      ))}
    </svg>
  );
}

const ICON = {
  close: 'M6 6l12 12 M18 6L6 18',
  plus: 'M12 5v14 M5 12h14',
};

/**
 * Side Chat ids whose route was ALREADY re-attached (or whose resume was
 * already attempted) this page lifetime (§10.5.3). Keyed by id → resume run
 * id so a remounted panel can still read the run's settled phase from the
 * operation store. In-memory only: a page reload re-dispatches `sidechat.resume`
 * exactly once per still-open record, when its panel first renders.
 */
const resumeMarks = new Map<string, string>();

/** Test hook — page-lifetime marks must not leak between test cases. */
export function __resetSideChatResumeMarksForTests(): void {
  resumeMarks.clear();
}

/**
 * Duplicate-creation guard + failure surfacing for `sidechat.create` (§15).
 * Create mints a fresh entity key per run (the Side Chat does not exist
 * yet), so the dispatcher's duplicate guard does not apply — the local
 * in-flight check is the double-submit protection. A confirmed create
 * arrives via `sidechat:created`; a failed/timed-out run is the ONLY signal
 * that nothing may appear, so it toasts.
 */
function useSideChatCreateRun() {
  const t = useT();
  const dispatch = useOperationDispatch();
  const inFlight = usePendingOperations();
  const [runId, setRunId] = useState<string>();
  const run = useOperationRun(runId);
  const signaledRunRef = useRef<string | null>(null);

  const creating = inFlight.some(entry => entry.name === 'sidechat.create')
    || run?.phase === 'pending';

  useEffect(() => {
    if (!run || signaledRunRef.current === run.id) return;
    if (run.phase === 'failed') {
      signaledRunRef.current = run.id;
      toast({ kind: 'error', message: run.error ?? t('sidechat.createFailed') });
    } else if (run.phase === 'timed-out') {
      signaledRunRef.current = run.id;
      // Unknown outcome (§4.3) — never a silent success, never an error
      // either: the record still appears if the Host confirms it.
      toast({ kind: 'warning', message: t('sidechat.createUnknown') });
    }
  }, [run, t]);

  return { dispatch, creating, setRunId };
}

/**
 * Close flow (§10.5.4) for the SELECTED record: 4-clause confirm → pending
 * run (double-submit blocked by the dispatcher's `sidechat:<id>` entity
 * guard) → `closing`, never back to open; removal happens only on
 * authoritative success (`onClosed`) or when the record disappears from the
 * read model. Lives at the dock level so the tab strip's ✕ and the panel
 * banner share one flow. A retry continues the SAME confirmed close (the
 * user is not re-asked; Host-side idempotency per §10.5.4).
 */
function useSideChatClose(
  sideChat: SideChatInfo | null,
  onClosed: (sidechatId: string) => void,
) {
  const t = useT();
  const dispatch = useOperationDispatch();
  const [closeRun, setCloseRun] = useState<{ id: string; sidechatId: string }>();
  const run = useOperationRun(closeRun?.id);
  const closePending = useOperationPending(
    sideChat ? sidechatEntityKey(sideChat.id) : 'sidechat:none',
    'sidechat.close',
  );
  const closeFailed = Boolean(
    sideChat && closeRun?.sidechatId === sideChat.id
    && (run?.phase === 'failed' || run?.phase === 'timed-out'),
  );
  const closing = Boolean(
    sideChat && (sideChat.status === 'closing' || closePending || closeFailed),
  );

  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  useEffect(() => {
    if (run?.phase === 'confirmed' && closeRun) onClosedRef.current(closeRun.sidechatId);
  }, [run?.phase, closeRun]);

  async function requestClose() {
    if (!sideChat || closing) return;
    const confirmed = await confirmDialog({
      message: sideChatCloseConfirmMessage(t),
      danger: true,
      confirmLabel: t('sidechat.closeConfirm.confirmLabel'),
    });
    if (!confirmed) return;
    const next = dispatch('sidechat.close', { sidechatId: sideChat.id });
    setCloseRun({ id: next.id, sidechatId: sideChat.id });
  }

  function retryClose() {
    if (!sideChat) return;
    const next = dispatch('sidechat.close', { sidechatId: sideChat.id });
    setCloseRun({ id: next.id, sidechatId: sideChat.id });
  }

  return { closing, closePending, closeFailed, requestClose, retryClose };
}

// ─── Dock (panel-2 content) ────────────────────────────────────────────────

export interface SideChatDockProps {
  /** Parent Session the dock's Side Chats are bound to. */
  parent: Session;
  /** Read-model records bound to `parent` (any status — open, closing,
   *  unavailable). Unsorted; the dock orders by created_at. */
  sideChats: SideChatInfo[];
  /** Per-Side-Chat transcript items (snapshot projection + live echoes,
   *  produced by use-app-socket). */
  items: Record<string, TranscriptItem[]>;
  /** Gating state of the standard create control (`sidechat.create`,
   *  §9.4/§10.3) — the "+" chip and the empty-state CTA read it. Null when
   *  gating is unavailable (treated as disabled). */
  control: ActionControlState | null;
  /** Authoritative local removal after a confirmed close (the Host also
   *  broadcasts `sidechat:closed`; this converges the UI immediately). */
  onClosed: (sidechatId: string) => void;
}

export function SideChatDock({
  parent,
  sideChats,
  items,
  control,
  onClosed,
}: SideChatDockProps) {
  const t = useT();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { dispatch, creating, setRunId } = useSideChatCreateRun();

  const records = useMemo(
    () => sideChats.slice().sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [sideChats],
  );

  // Local "which one is viewed" selection. Default/fallback: the newest
  // record; a record that newly appears (the just-created one) takes focus.
  const knownIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const known = knownIdsRef.current;
    const added = records.filter(record => !known.has(record.id));
    knownIdsRef.current = new Set(records.map(record => record.id));
    if (added.length > 0 && known.size > 0) {
      setSelectedId(added[added.length - 1]!.id);
    }
  }, [records]);
  const effectiveSelectedId = records.some(record => record.id === selectedId)
    ? selectedId
    : (records[records.length - 1]?.id ?? null);
  const selected = records.find(record => record.id === effectiveSelectedId) ?? null;

  const createEnabled = control?.enabled === true && !creating;
  const createTitle = control?.enabled
    ? (creating ? t('sidechat.creating') : t('sidechat.createTitle'))
    : (control?.reason ?? t('sidechat.unavailable'));
  const requestCreate = () => {
    if (!createEnabled) return;
    const run = dispatch('sidechat.create', { parentSessionId: parent.id });
    setRunId(run.id);
  };

  const closeView = useSideChatClose(selected, onClosed);

  return (
    <div className="sidechat-root" data-testid="sidechat-dock">
      {/* Single terminal-style tab strip (same `.sheet-tabs` language as the
          workbench terminal): one tab per open Side Chat, the active tab
          carries its close ✕ (permanent delete, §10.5.4), "+" is the gated
          standard create control (§15: always visible, greyed with the
          Proxy/session reason when either gating layer disallows it). */}
      <div className="sheet-tabs sidechat-tabs" role="tablist" aria-label={t('sidechat.title')}>
        {records.map((record, index) => {
          const active = record.id === effectiveSelectedId;
          return (
            <button
              key={record.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`sidechat-chip-${record.id}`}
              className={`sheet-tab${active ? ' active' : ''}${record.status !== 'open' ? ` is-${record.status}` : ''}`}
              title={record.status === 'open' ? undefined : t(`sidechat.state.${record.status}`)}
              onClick={() => setSelectedId(record.id)}
            >
              <span className="name">{sideChatLabel(t, record, index)}</span>
              {record.status !== 'open' && (
                <span className={`sidechat-state is-${record.status}`}>
                  {t(`sidechat.state.${record.status}`)}
                </span>
              )}
              {active && !closeView.closing && (
                <span
                  role="button"
                  className="tab-x"
                  data-testid={`sidechat-close-${record.id}`}
                  aria-label={t('sidechat.close')}
                  title={t('sidechat.close')}
                  onClick={event => {
                    event.stopPropagation();
                    void closeView.requestClose();
                  }}
                >
                  <SvgIcon d={ICON.close} size={10} />
                </span>
              )}
            </button>
          );
        })}
        <button
          type="button"
          className="sheet-tab sidechat-new prominent"
          data-testid="sidechat-create"
          disabled={!createEnabled}
          title={createTitle}
          aria-label={t('sidechat.new')}
          onClick={requestCreate}
        >
          <SvgIcon d={ICON.plus} size={12} />
        </button>
      </div>
      {selected ? (
        <SideChatPanel
          key={selected.id}
          parent={parent}
          sideChat={selected}
          items={items[selected.id] ?? []}
          closeView={closeView}
        />
      ) : (
        <div className="sidechat-empty">
          <p>{t('sidechat.empty')}</p>
          <button
            type="button"
            className="btn sm primary sidechat-create-cta"
            data-testid="sidechat-create-empty"
            disabled={!createEnabled}
            title={createTitle}
            aria-label={t('sidechat.new')}
            onClick={requestCreate}
          >
            <SvgIcon d={ICON.plus} size={14} />
            <span>{t('sidechat.new')}</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ─── One Side Chat's panel ─────────────────────────────────────────────────

function SideChatPanel({
  parent,
  sideChat,
  items,
  closeView,
}: {
  parent: Session;
  sideChat: SideChatInfo;
  items: TranscriptItem[];
  /** Dock-owned close flow (§10.5.4) — the banner reads it; the tab ✕ owns
   *  the trigger. */
  closeView: {
    closing: boolean;
    closePending: boolean;
    closeFailed: boolean;
    requestClose: () => void;
    retryClose: () => void;
  };
}) {
  const t = useT();
  const dispatch = useOperationDispatch();

  // §10.5.3 restart/reconnect recovery: re-attach the route exactly once per
  // page lifetime, when the record's panel first renders. The dispatcher's
  // duplicate guard covers any repeat within an in-flight run; the mark
  // covers later remounts. Recovery NEVER retries a crashed turn — it only
  // re-attaches the existing runtime context.
  const [resumeRunId, setResumeRunId] = useState<string | undefined>(() => resumeMarks.get(sideChat.id));
  const resumeRun = useOperationRun(resumeRunId);
  const resumePending = useOperationPending(sidechatEntityKey(sideChat.id), 'sidechat.resume');
  useEffect(() => {
    if (sideChat.status !== 'open' || resumeMarks.has(sideChat.id)) return;
    const run = dispatch('sidechat.resume', {
      sidechatId: sideChat.id,
      parentSessionId: sideChat.parent_session_id,
    });
    resumeMarks.set(sideChat.id, run.id);
    setResumeRunId(run.id);
  }, [sideChat.id, sideChat.parent_session_id, sideChat.status, dispatch]);

  // Recovering: record open but this page has no settled resume yet. The
  // composer is replaced by a stable banner so duplicate sends are blocked.
  const recovering = sideChat.status === 'open' && (resumeRunId === undefined || resumePending);
  // Resume failure (definitive or unknown): keep the transient content, show
  // cannot-continue + a close entry — never fake an empty fresh Side Chat
  // (§10.5.3). Records arriving as 'unavailable' land here directly.
  const resumeSettledBad = resumeRun?.phase === 'failed' || resumeRun?.phase === 'timed-out';
  const cannotContinue = sideChat.status === 'unavailable' || (sideChat.status === 'open' && resumeSettledBad);

  // Turn-running state: the snapshot's `state` is authoritative for the
  // route lifecycle (running / waiting_interaction); a still-pending
  // optimistic echo covers the window before turn.started lands.
  const echoPending = items.some(item => item.kind === 'user' && item.pending === true);
  const turnRunning = sideChat.state === 'running'
    || sideChat.state === 'waiting_interaction'
    || echoPending;

  const turnConfigOverlay = useOverlayField(sidechatEntityKey(sideChat.id), 'turn_config');
  const turnConfig = (turnConfigOverlay?.value as Record<string, ConfigValue> | undefined)
    ?? sideChat.turn_config
    ?? {};
  const configuredSideChat = useMemo(
    () => ({ ...sideChat, turn_config: turnConfig }),
    [sideChat, turnConfig],
  );
  const composerSession = useMemo(
    () => sideChatComposerSession(configuredSideChat, parent),
    [configuredSideChat, parent],
  );

  function setTurnConfig(optionId: string, value: ConfigValue): void {
    const option = configuredSideChat.turn_config_options
      ?.find(entry => entry.id === optionId && entry.binding === 'turn');
    if (!option) return;
    dispatch('sidechat.setTurnConfig', {
      sidechatId: sideChat.id,
      optionId,
      value,
      turnConfig: { ...turnConfig, [optionId]: value },
    });
  }

  function setRole(role: string, value: ConfigValue): void {
    const option = configuredSideChat.turn_config_options
      ?.find(entry => entry.binding === 'turn' && entry.role === role);
    if (option) setTurnConfig(option.id, value);
  }

  return (
    <section className="sidechat-panel" data-testid={`sidechat-panel-${sideChat.id}`}>
      <div className="sidechat-scroll">
        <Transcript
          items={items}
          pending={turnRunning}
          onApprove={(
            approvalId: string,
            decision: ApprovalDecision,
            answers?: Record<string, string | boolean | string[]>,
            context?: ApprovalActionContext,
          ) => dispatch('approval.resolve', {
            // interaction.respond on the Side Chat route (§10.5.1) — the Host
            // routes approval:resolve by session_id = sidechat id.
            sessionId: sideChat.id,
            approvalId,
            decision,
            ...(answers ? { answers } : {}),
            ...(context?.nativeOptionId ? { nativeOptionId: context.nativeOptionId } : {}),
          })}
        />
      </div>

      {recovering ? (
        <div className="sidechat-banner" role="status" data-testid="sidechat-recovering">
          <span className="spinner" aria-hidden="true" />
          <span>{t('sidechat.recovering')}</span>
        </div>
      ) : cannotContinue ? (
        <div className="sidechat-banner warn" role="alert" data-testid="sidechat-cannot-continue">
          <span>{t('sidechat.cannotContinue')}</span>
          <button
            type="button"
            className="btn xs danger-ghost"
            data-testid={`sidechat-close-entry-${sideChat.id}`}
            onClick={() => { void closeView.requestClose(); }}
          >
            {t('sidechat.close')}
          </button>
        </div>
      ) : closeView.closing ? (
        <div className="sidechat-banner" role="status" data-testid="sidechat-closing">
          {closeView.closePending && <span className="spinner" aria-hidden="true" />}
          <span>{closeView.closeFailed ? t('sidechat.closeFailed') : t('sidechat.closing')}</span>
          {closeView.closeFailed && (
            <button
              type="button"
              className="btn xs secondary"
              data-testid={`sidechat-retry-close-${sideChat.id}`}
              onClick={closeView.retryClose}
            >
              {t('sidechat.retryClose')}
            </button>
          )}
        </div>
      ) : (
        <Composer
          session={composerSession}
          variant="sidechat"
          onSend={(text, options) => {
            // turn.start on the Side Chat route: message:send with
            // session_id = sidechat id, through the same operation layer.
            dispatchMessageSend(dispatch, {
              sessionId: sideChat.id,
              text,
              exec: parent.executor,
              turnConfig,
              ...(options?.contextItems && options.contextItems.length > 0
                ? { contextItems: options.contextItems }
                : {}),
            });
          }}
          onSendSkill={() => { /* restricted variant: no slash UI */ }}
          onStop={() => dispatch('session.stop', { sessionId: sideChat.id })}
          onQueueAdd={() => { /* 'block' behavior never reaches the queue */ }}
          // These update Gian's Side Chat next-turn draft. They never call an
          // ordinary Session config method with the transient Side Chat id.
          onSetMode={mode => setRole('approval_mode', mode)}
          onSetModel={model => setRole('model', model)}
          onSetEffort={effort => setRole('effort', effort)}
          onSetServiceTier={tier => setRole('fast', tier === 'fast')}
          onSetTurnConfig={setTurnConfig}
          disabled={turnRunning}
          running={turnRunning}
          disabledSubmitBehavior="block"
          busyPlaceholder={t('sidechat.turnRunning')}
          executor={parent.executor}
          workspaceId={parent.workspace_id ?? undefined}
        />
      )}
    </section>
  );
}
