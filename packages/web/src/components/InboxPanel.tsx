/**
 * Inbox panel (Issue #53 / 0.6.7): Pending/History tabs over the canonical
 * Inbox store. Opening the panel or a tab never marks anything read — only
 * opening a specific item does, with the exact observed generation (the Host
 * fences stale generations with 409; a conflict refreshes canonical state
 * instead of retrying). Unread is visual state only; the badge counts
 * pending work.
 *
 * Layout: full-width overlay on narrow screens, right-anchored global panel
 * on desktop (see styles/inbox.css). Focus is trapped while open and
 * restored on close.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ApprovalDecision, InboxAction, InboxItemPublic } from '@gian/shared';
import { useLocale, useT } from '../i18n/index.js';
import { loadInboxItem, loadInboxPage } from '../api.js';
import { toast } from '../feedback.js';
import { useOperationPending } from '../operations/use-operations.js';
import {
  getInboxSnapshot,
  invalidateInbox,
  loadMorePending,
  markInboxItemRead,
  markInboxItemUnread,
  refreshInbox,
  subscribeInbox,
} from '../controllers/inbox.js';

interface HistoryState {
  status: 'idle' | 'loading' | 'error' | 'ready';
  items: InboxItemPublic[];
  nextCursor: string | null;
}

const idleHistory: HistoryState = { status: 'idle', items: [], nextCursor: null };

function formatItemTime(iso: string, locale: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  return new Date(time).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** The interaction id a session-scoped item's domain decision binds to. */
function itemInteractionId(item: InboxItemPublic): string | null {
  if (item.display.kind === 'schedule.confirmation') return item.display.confirmation_id;
  return item.display.kind === 'session.approval' || item.display.kind === 'session.question'
    ? item.display.interaction_id
    : null;
}

const ACTION_LABEL_KEYS: Record<InboxAction, string> = {
  open: 'inbox.action.open',
  answer: 'inbox.action.answer',
  cancel: 'inbox.action.cancel',
  approve: 'inbox.action.approve',
  reject: 'inbox.action.reject',
  skip_version: 'inbox.action.skipVersion',
  retry: 'inbox.retry',
};

const DESTRUCTIVE_ACTIONS: ReadonlySet<InboxAction> = new Set(['reject', 'cancel']);

/** Detail for one item: full title/summary/meta plus the Host-advertised
 *  actions. Decisions dispatch through the EXISTING domain operations
 *  (approval.resolve / schedule.resolveConfirmation / pairing confirm) —
 *  the Inbox adds no parallel approve path. Plan-review items keep their
 *  three real decisions (accept_with_ask / accept_with_auto /
 *  keep_planning); generic approvals use the baseline allow_once/decline
 *  the transcript card offers — native-option variants stay on the
 *  canonical card, one "Open" away. While the matching operation run is in
 *  flight the action row is disabled; the canonical close arrives as an
 *  `inbox:changed` upsert and the detail returns to the list. */
function InboxItemDetail({
  item,
  onBack,
  onAction,
}: {
  item: InboxItemPublic;
  onBack: () => void;
  onAction: (item: InboxItemPublic, action: InboxAction, decision?: ApprovalDecision) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const interactionId = itemInteractionId(item);
  const approvalPending = useOperationPending(
    interactionId ? `approval:${interactionId}` : 'inbox:none',
    'approval.resolve',
  );
  const schedulePending = useOperationPending(
    interactionId ? `schedule-confirmation:${interactionId}` : 'inbox:none',
    'schedule.resolveConfirmation',
  );
  const busy = approvalPending || schedulePending;
  const pending = item.status === 'pending';
  const isPlan = item.display.kind === 'session.approval' && item.display.category === 'plan';

  return (
    <div className="inbox-detail" data-testid={`inbox-detail-${item.id}`}>
      <div className="inbox-detail-head">
        <button type="button" className="inbox-head-btn" title={t('inbox.detail.back')} aria-label={t('inbox.detail.back')} onClick={onBack}>
          <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <span className="inbox-row-kind">{t(`inbox.kind.${item.source_kind}`)}</span>
        <span className="inbox-detail-status" data-status={item.status}>{t(`inbox.status.${item.status}`)}</span>
        <span className="inbox-row-time">{formatItemTime(item.updated_at, locale)}</span>
      </div>
      <div className="inbox-detail-body">
        <div className="inbox-detail-title">{item.title}</div>
        {item.summary !== '' && <div className="inbox-detail-summary">{item.summary}</div>}
      </div>
      {pending && item.actions.length > 0 && (
        <div className="inbox-actions">
          {item.actions.flatMap(action => {
            if (isPlan && action === 'approve') {
              return [
                <button key="approve-ask" type="button" className="inbox-action primary"
                  data-testid="inbox-action-approve-ask" disabled={busy}
                  onClick={() => onAction(item, 'approve', 'accept_with_ask')}>
                  {t('transcript.approval.manualApprove')}
                </button>,
                <button key="approve-auto" type="button" className="inbox-action"
                  data-testid="inbox-action-approve-auto" disabled={busy}
                  onClick={() => onAction(item, 'approve', 'accept_with_auto')}>
                  {t('transcript.approval.autoAccept')}
                </button>,
              ];
            }
            if (isPlan && action === 'reject') {
              return [
                <button key="reject" type="button" className="inbox-action danger"
                  data-testid="inbox-action-reject" disabled={busy}
                  onClick={() => onAction(item, 'reject', 'keep_planning')}>
                  {t('transcript.approval.keepPlanning')}
                </button>,
              ];
            }
            const decision: ApprovalDecision | undefined = action === 'approve'
              ? 'allow_once'
              : action === 'reject' || action === 'cancel'
                ? 'decline'
                : undefined;
            return [
              <button
                key={action}
                type="button"
                className={`inbox-action${DESTRUCTIVE_ACTIONS.has(action) ? ' danger' : action === 'open' || action === 'answer' || action === 'approve' ? ' primary' : ''}`}
                data-testid={`inbox-action-${action}`}
                disabled={busy}
                onClick={() => onAction(item, action, decision)}
              >
                {t(ACTION_LABEL_KEYS[action])}
              </button>,
            ];
          })}
        </div>
      )}
    </div>
  );
}

export function InboxPanel({
  open,
  onClose,
  onAction,
  focusItem,
}: {
  open: boolean;
  onClose: () => void;
  /** Row/detail entry point. The panel renders only Host-advertised actions
   *  and passes the exact domain decision; App routes them to the existing
   *  navigation and domain operations. */
  onAction: (item: InboxItemPublic, action: InboxAction, decision?: ApprovalDecision) => void;
  /** Search deep link (Issue #168): open this exact item's detail — from the
   *  pending window when present, else a one-shot detail fetch. The
   *  generation is the one the search hit showed: a moved generation is
   *  refreshed and NEVER auto-opened/read. */
  focusItem?: { id: string; generation: number; nonce: number } | null;
}) {
  const t = useT();
  const locale = useLocale();
  const inbox = useSyncExternalStore(subscribeInbox, getInboxSnapshot, getInboxSnapshot);
  const [tab, setTab] = useState<'pending' | 'history'>('pending');
  const [history, setHistory] = useState<HistoryState>(idleHistory);
  const [selected, setSelected] = useState<InboxItemPublic | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const historyRequestRef = useRef(0);
  /** Latest detail-open request wins; closing the panel retires it. */
  const detailRequestRef = useRef(0);
  /** Live panel-open flag for async completions. */
  const openRef = useRef(open);
  openRef.current = open;

  // Focus trap + restoration. The panel keeps the current view visible
  // behind it, so closing must return focus where the user left it. Closing
  // also retires any in-flight detail-open request.
  useEffect(() => {
    if (!open) return;
    const restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>('.inbox-close')?.focus();
    return () => {
      historyRequestRef.current += 1;
      detailRequestRef.current += 1;
      restoreTo?.focus();
    };
  }, [open]);

  // History is a lazy REST read (closed items are not part of the WS pending
  // snapshot). Re-pull on every open of the tab so stale rows don't linger;
  // the retry button runs the same loader.
  const loadHistoryFirstPage = useCallback(() => {
    const token = ++historyRequestRef.current;
    setHistory({ status: 'loading', items: [], nextCursor: null });
    void loadInboxPage({ status: 'closed', limit: 50 })
      .then(page => {
        if (historyRequestRef.current !== token) return;
        setHistory({ status: 'ready', items: page.items, nextCursor: page.next_cursor });
      })
      .catch(() => {
        if (historyRequestRef.current !== token) return;
        setHistory({ status: 'error', items: [], nextCursor: null });
      });
  }, []);
  useEffect(() => {
    if (open && tab === 'history') loadHistoryFirstPage();
  }, [open, tab, loadHistoryFirstPage]);

  // The detail follows the live store row. A pending item that leaves the
  // pending window (resolved here or on another client) closes the detail —
  // its actionable purpose is gone; the canonical row lives in History. A
  // deep-linked item that was never in either list keeps its fetched copy.
  // Exact-generation contract: a live row at a NEWER generation is a
  // different occurrence — the open detail never swaps onto it, it closes.
  const selectedFromListRef = useRef(true);
  const liveSelected = selected
    ? (() => {
        const live = inbox.pendingItems.find(item => item.id === selected.id)
          ?? history.items.find(item => item.id === selected.id);
        if (live) return live.generation === selected.generation ? live : null;
        return selectedFromListRef.current ? null : selected;
      })()
    : null;
  useEffect(() => {
    if (selected && !liveSelected) setSelected(null);
  }, [selected, liveSelected]);

  // Replacing the list/detail removes its focused button. Keep keyboard
  // navigation inside the dialog so Escape still reaches the panel.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>(
      liveSelected ? '.inbox-detail-head button' : '.inbox-close',
    )?.focus();
  }, [open, liveSelected?.id]);

  // Search deep link: open the exact item. Pending window hit → detail from
  // the store; otherwise a one-shot canonical detail fetch. Same read-on-open
  // semantics as a row click. The hit's generation is verified first — a
  // moved generation refreshes canonical state and is never auto-opened/read.
  useEffect(() => {
    const request = ++detailRequestRef.current;
    if (!open || !focusItem) return;
    const openVerified = (item: InboxItemPublic, fromList: boolean) => {
      if (request !== detailRequestRef.current) return;
      if (item.generation !== focusItem.generation) {
        toast({ kind: 'warning', message: t('inbox.staleRefresh') });
        invalidateInbox();
        return;
      }
      selectedFromListRef.current = fromList;
      openDetail(item);
    };
    const fromStore = getInboxSnapshot().pendingItems.find(item => item.id === focusItem.id);
    if (fromStore) {
      openVerified(fromStore, true);
      return;
    }
    let alive = true;
    void loadInboxItem(focusItem.id)
      .then(item => {
        if (!alive) return;
        openVerified(item, false);
      })
      .catch(() => undefined);
    return () => { alive = false; };
    // Read echoes update pendingItems; they are not new navigation intents.
    // Key on primitives so a rebuilt prop cannot reopen a retired detail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, focusItem?.id, focusItem?.generation, focusItem?.nonce]);

  // Disabling a pending decision can blur its button onto body. The open
  // modal still owns Escape; do not depend on focus remaining in the panel.
  useEffect(() => {
    if (!open) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      retireDetailRequest();
      if (!selected) onClose();
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [open, selected, onClose]);

  if (!open) return null;

  function retryHistory() {
    loadHistoryFirstPage();
  }

  function loadMoreHistory() {
    if (!history.nextCursor) return;
    const token = ++historyRequestRef.current;
    setHistory(previous => ({ ...previous, status: 'loading' }));
    void loadInboxPage({ status: 'closed', limit: 50, cursor: history.nextCursor })
      .then(page => {
        if (historyRequestRef.current !== token) return;
        setHistory(previous => ({
          status: 'ready',
          items: [...previous.items, ...page.items],
          nextCursor: page.next_cursor,
        }));
      })
      .catch(() => {
        if (historyRequestRef.current !== token) return;
        setHistory(previous => ({ ...previous, status: 'error' }));
      });
  }

  function openDetail(item: InboxItemPublic) {
    // One detail request wins: a newer click supersedes an in-flight read,
    // and closing the panel retires it.
    const request = ++detailRequestRef.current;
    // Read exactly the observed generation when the user opens the item. A
    // stale generation means the item changed under the user: canonical state
    // was refreshed by the store — do not open the old target.
    void markInboxItemRead(item).then(result => {
      if (request !== detailRequestRef.current) return;
      if (!openRef.current) return;
      if (result === 'stale') {
        toast({ kind: 'warning', message: t('inbox.staleRefresh') });
        return;
      }
      if (item.status === 'pending') {
        // A pending item's detail opens only when the canonical row is still
        // pending at the same generation — terminal/expired/moved items are
        // never resurrected by the late response.
        const live = getInboxSnapshot().pendingItems.find(entry => entry.id === item.id);
        if (!live || live.status !== 'pending' || live.generation !== item.generation) return;
        setSelected(live);
        return;
      }
      // History/closed rows open their read-only detail as-is (they are not
      // in the pending window by design).
      setSelected(item);
    });
  }

  function toggleUnread(item: InboxItemPublic) {
    const action = item.unread ? markInboxItemRead : markInboxItemUnread;
    void action(item).then(result => {
      if (result === 'stale') toast({ kind: 'warning', message: t('inbox.staleRefresh') });
    });
  }

  /** Leaving the detail — back, Esc, or a tab switch while a read is still
   *  in flight — retires the open request so a late response can never open
   *  (or reopen) a detail the user already walked away from. */
  function retireDetailRequest() {
    detailRequestRef.current += 1;
    setSelected(null);
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input'),
    ).filter(element => element.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !panel.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  function renderRow(item: InboxItemPublic) {
    return (
      <div
        key={item.id}
        className="inbox-row"
        data-unread={item.unread || undefined}
        data-testid={`inbox-item-${item.id}`}
      >
        <button
          type="button"
          className="inbox-row-main"
          onClick={() => { selectedFromListRef.current = true; openDetail(item); }}
        >
          <span className="inbox-row-head">
            <span className="inbox-row-kind">{t(`inbox.kind.${item.source_kind}`)}</span>
            <span className="inbox-row-title">{item.title}</span>
            <span className="inbox-row-time">{formatItemTime(item.updated_at, locale)}</span>
          </span>
          {item.summary !== '' && <span className="inbox-row-summary">{item.summary}</span>}
        </button>
        <button
          type="button"
          className="inbox-row-read"
          data-testid={`inbox-read-${item.id}`}
          title={item.unread ? t('inbox.markRead') : t('inbox.markUnread')}
          aria-label={item.unread ? t('inbox.markRead') : t('inbox.markUnread')}
          aria-pressed={!item.unread}
          onClick={() => toggleUnread(item)}
        >
          <span className="inbox-read-dot" aria-hidden="true" />
        </button>
      </div>
    );
  }

  const pendingItems = inbox.pendingItems;

  return (
    <div
      className="inbox-overlay"
      onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        className="inbox-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('inbox.title')}
        onKeyDown={handleKeyDown}
      >
        {liveSelected ? (
          <InboxItemDetail
            item={liveSelected}
            onBack={retireDetailRequest}
            onAction={onAction}
          />
        ) : (
          <>
        <div className="inbox-head">
          <div className="inbox-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'pending'}
              className={`inbox-tab${tab === 'pending' ? ' active' : ''}`}
              data-testid="inbox-tab-pending"
              onClick={() => { detailRequestRef.current += 1; setTab('pending'); }}
            >
              {t('inbox.tab.pending')}
              {inbox.pendingCount > 0 && <span className="inbox-tab-count">{inbox.pendingCount}</span>}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'history'}
              className={`inbox-tab${tab === 'history' ? ' active' : ''}`}
              data-testid="inbox-tab-history"
              onClick={() => { detailRequestRef.current += 1; setTab('history'); }}
            >
              {t('inbox.tab.history')}
            </button>
          </div>
          <button
            type="button"
            className="inbox-head-btn"
            title={t('inbox.refresh')}
            aria-label={t('inbox.refresh')}
            disabled={inbox.refreshing}
            onClick={() => { void refreshInbox(); }}
          >
            <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <polyline points="21 3 21 9 15 9" />
            </svg>
          </button>
          <button
            type="button"
            className="inbox-head-btn inbox-close"
            title={t('inbox.close')}
            aria-label={t('inbox.close')}
            onClick={onClose}
          >
            <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="inbox-list">
          {tab === 'pending' ? (
            !inbox.hydrated && !inbox.error ? (
              <div className="inbox-empty">{t('inbox.loading')}</div>
            ) : inbox.error && pendingItems.length === 0 ? (
              <div className="inbox-empty">
                <span>{t('inbox.loadFailed')}</span>
                <button type="button" className="inbox-retry" onClick={() => { void refreshInbox(); }}>
                  {t('inbox.retry')}
                </button>
              </div>
            ) : pendingItems.length === 0 ? (
              <div className="inbox-empty">{t('inbox.empty.pending')}</div>
            ) : (
              <>
                {inbox.error && (
                  <div className="inbox-error-row">
                    <span>{t('inbox.loadFailed')}</span>
                    <button type="button" className="inbox-retry" onClick={() => { void refreshInbox(); }}>
                      {t('inbox.retry')}
                    </button>
                  </div>
                )}
                {pendingItems.map(renderRow)}
                {inbox.truncated && (
                  <button
                    type="button"
                    className="inbox-more"
                    data-testid="inbox-pending-more"
                    disabled={inbox.loadingMore || inbox.refreshing}
                    onClick={() => { void loadMorePending(); }}
                  >
                    {inbox.loadingMore || inbox.refreshing ? t('inbox.loading') : t('inbox.loadMore')}
                  </button>
                )}
              </>
            )
          ) : history.status === 'loading' && history.items.length === 0 ? (
            <div className="inbox-empty">{t('inbox.loading')}</div>
          ) : history.status === 'error' && history.items.length === 0 ? (
            <div className="inbox-empty">
              <span>{t('inbox.loadFailed')}</span>
              <button type="button" className="inbox-retry" onClick={retryHistory}>
                {t('inbox.retry')}
              </button>
            </div>
          ) : history.items.length === 0 ? (
            <div className="inbox-empty">{t('inbox.empty.history')}</div>
          ) : (
            <>
              {history.items.map(renderRow)}
              {history.nextCursor && (
                <button
                  type="button"
                  className="inbox-more"
                  disabled={history.status === 'loading'}
                  onClick={loadMoreHistory}
                >
                  {history.status === 'loading' ? t('inbox.loading') : t('inbox.loadMore')}
                </button>
              )}
              {history.status === 'error' && (
                <button type="button" className="inbox-more" onClick={loadMoreHistory}>
                  {t('inbox.retry')}
                </button>
              )}
            </>
          )}
        </div>
          </>
        )}
      </div>
    </div>
  );
}
