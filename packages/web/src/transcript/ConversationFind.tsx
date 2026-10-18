/**
 * Conversation find (Issue #168 / 0.6.7, proposal §7): Cmd/Ctrl+F over the
 * COMPLETE persisted history, not the mounted DOM. Match identity, order,
 * ranges and counts come from the Host find API (contract shared/search.ts);
 * a match outside the loaded window hydrates its bounded context window
 * (`/api/sessions/:id/context`) instead of paging the whole history in.
 *
 * Highlighting maps the Host's canonical UTF-16 range onto the DOM through
 * per-message projection alignment (find-in-transcript.ts): the rendered
 * message must align EXACTLY with the shared projection (projectSearchText /
 * projectComposerSearchText), math/images resolve to atomic visible element
 * anchors, and any disagreement re-queries once per (query, message, text
 * revision) — never a guessed highlight, never an invisible node. React DOM,
 * message text and copy behavior are never mutated (CSS Custom Highlight API
 * over Ranges).
 *
 * Freshness discipline: every query/pagination request binds the find
 * generation at start; a user query edit, session switch or close supersedes
 * in-flight work and resets matches. Same-query refreshes (streaming drift,
 * stale revision, error retry) keep the locate anchor and confirm it with
 * cursors returned by that refresh. Matches from an older page are not reused.
 * A context load's failure refresh belongs to the locate intent that started it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { FindMatch } from '@gian/shared';
import { normalizeSearchText, projectComposerSearchText, projectSearchText } from '@gian/shared';
import { useT } from '../i18n/index.js';
import { findInSession, SearchApiError } from '../api.js';
import type { TranscriptHistoryState } from '../controllers/use-transcript-hydration.js';
import type { TranscriptItem } from '../types.js';
import { transcriptItemIdentity } from '@gian/chat-ui';
import {
  alignMessageToProjection,
  rangeForProjectionRange,
  revealTranscriptMatch,
  type MappedRange,
} from './find-in-transcript.js';

const HIGHLIGHT = 'gian-find';
const ACTIVE_HIGHLIGHT = 'gian-find-active';
const FIND_PAGE_LIMIT = 50;
const FIND_DEBOUNCE_MS = 200;

export interface FindContextRequest {
  turnId?: string;
  turn?: number;
  documentId?: string;
  textRevision?: string;
}

interface FindResults {
  status: 'idle' | 'loading' | 'error' | 'ready';
  matches: FindMatch[];
  total: number;
  totalComplete: boolean;
  nextCursor: string | null;
  partial: boolean;
  loadingMore: boolean;
}

const IDLE_RESULTS: FindResults = {
  status: 'idle',
  matches: [],
  total: 0,
  totalComplete: true,
  nextCursor: null,
  partial: false,
  loadingMore: false,
};

function appendFreshMatches(previous: FindMatch[], incoming: FindMatch[]): FindMatch[] {
  const seen = new Set(previous.map(match => match.id));
  const extra = incoming.filter(match => !seen.has(match.id));
  return extra.length === 0 ? previous : [...previous, ...extra];
}

/** A find page published as this round's result. `matches` / `nextCursor`
 *  override the page only with other pages from the same round. */
function freshFindResults(
  page: {
    matches: FindMatch[];
    total: number;
    total_complete: boolean;
    next_cursor: string | null;
    coverage: { complete: boolean };
  },
  matches: FindMatch[] = page.matches,
  nextCursor: string | null = page.next_cursor,
): FindResults {
  return {
    status: 'ready',
    matches,
    total: page.total,
    totalComplete: page.total_complete,
    nextCursor,
    partial: !page.coverage.complete,
    loadingMore: false,
  };
}

function highlightRegistry(): HighlightRegistry | null {
  try {
    return typeof CSS !== 'undefined' && CSS.highlights ? CSS.highlights : null;
  } catch {
    return null;
  }
}

function setHighlights(name: string, ranges: Range[]): void {
  const registry = highlightRegistry();
  if (!registry) return;
  if (ranges.length === 0) registry.delete(name);
  else registry.set(name, new Highlight(...ranges));
}

/** The canonical projection of one transcript item — identical inputs to the
 *  Host index (shared helpers, never regex over Markdown). */
function projectTranscriptItem(item: TranscriptItem): string | null {
  if (item.kind === 'user') {
    return item.composerDocument
      ? projectComposerSearchText(item.composerDocument)
      : projectSearchText(item.text);
  }
  if (item.kind === 'assistant') return projectSearchText(item.text);
  return null;
}

export function ConversationFind({
  sessionId,
  scopeRef,
  items,
  history,
  contentSignal,
  onLoadMessageContext,
  onActiveChange,
}: {
  sessionId: string;
  /** The `.main-scroll` transcript scope. */
  scopeRef: RefObject<HTMLElement | null>;
  /** The loaded transcript window — projections and element lookup both come
   *  from it, so a detached context window searches itself, not the tail. */
  items: TranscriptItem[];
  history?: TranscriptHistoryState;
  /** Content drift signal (items count + trailing text length): streaming
   *  turns re-run the open query (debounced) so counts and Host matches do
   *  not silently drift from the transcript. */
  contentSignal?: string;
  onLoadMessageContext?: (request: FindContextRequest) => Promise<boolean>;
  onActiveChange: (active: boolean) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FindResults>(IDLE_RESULTS);
  const [activeIdx, setActiveIdx] = useState(0);
  const [domTick, setDomTick] = useState(0);
  /** Same-query refresh. A locate failure stores its locate generation;
   *  streaming, retry, and stale-cursor refreshes store null. */
  const [refreshRequest, setRefreshRequest] = useState<{ nonce: number; locateSeq: number | null }>({
    nonce: 0,
    locateSeq: null,
  });
  const requestQueryRefresh = useCallback((locateSeq: number | null) => {
    setRefreshRequest(current => ({ nonce: current.nonce + 1, locateSeq }));
  }, []);
  /** Bumps on an explicit Next/Previous so a same-index step still re-locates. */
  const [locateGeneration, setLocateGeneration] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  /**
   * Return-to-latest wins over the active hit. The query and match list stay;
   * the old hit is not revealed and does not load another context window
   * until the user steps Next/Previous.
   */
  const chaseSuspendedRef = useRef(false);
  /** Invalidates context loads started before the latest explicit locate:
   *  return-to-latest, Next, or Previous. */
  const locateSeqRef = useRef(0);
  /** Generation is only a return command within one session. */
  const returnWatchRef = useRef({
    sessionId,
    generation: history?.returnToLatestGeneration ?? 0,
  });
  /** True while the user is still in this Find operation (not another control). */
  const findEngagedRef = useRef(false);
  /** Find generation: query/session/close supersede in-flight requests. */
  const requestSeqRef = useRef(0);
  /** Live mirrors for async callbacks (never a stale closure). */
  const resultsRef = useRef(results);
  resultsRef.current = results;
  const activeIdxRef = useRef(activeIdx);
  activeIdxRef.current = activeIdx;
  /**
   * In-flight context loads, keyed by match id. The value is that request's
   * ticket. Only the ticket still stored for the id may release the slot: a
   * late load must not unlock a newer load of the same match, and a ticket
   * that still owns the slot releases it when its locate or query generation
   * has moved on so the slot cannot block the next query.
   */
  const contextLoadingRef = useRef(new Map<string, number>());
  const contextLoadTicketRef = useRef(0);
  /** Re-query at most once per (query, message, text revision). */
  const unmappableRef = useRef(new Set<string>());
  /** After a load-more resolves, advance once into the first new match. */
  const pendingAdvanceRef = useRef(false);
  /** Hit the user was on when a same-query refresh did not return it.
   *  Later pages of that refresh may confirm it. It is not itself a result. */
  const locateAnchorRef = useRef<string | null>(null);
  /** Caps a stale-cursor restart so an epoch change cannot refresh forever. */
  const anchorRestartRef = useRef(0);

  const close = useCallback(() => {
    requestSeqRef.current += 1;
    pendingAdvanceRef.current = false;
    locateAnchorRef.current = null;
    anchorRestartRef.current = 0;
    setOpen(false);
  }, []);

  // Cmd/Ctrl+F belongs to the conversation surface. It yields to open
  // dialogs and to editable surfaces with their own find (Browser panel,
  // Files inspector, terminal); the Composer keeps browser-like Cmd/Ctrl+F.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const isFindKey = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
        && event.key.toLowerCase() === 'f';
      if (!isFindKey) return;
      const scope = scopeRef.current;
      if (!scope || !scope.isConnected) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        const editable = tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
        if (editable) {
          const main = scope.closest('.main');
          if (!main || !main.contains(target)) return;
        }
      }
      if (document.querySelector('[aria-modal="true"], [role="dialog"]')) return;
      // The Browser rail's own find owns Cmd/Ctrl+F while it is visible.
      const browserPanel = document.querySelector<HTMLElement>('.browser-panel');
      if (browserPanel && browserPanel.offsetParent !== null) return;
      event.preventDefault();
      restoreFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      setOpen(true);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [scopeRef]);

  // Session switch resets the find state entirely and supersedes requests.
  useEffect(() => {
    requestSeqRef.current += 1;
    pendingAdvanceRef.current = false;
    locateAnchorRef.current = null;
    anchorRestartRef.current = 0;
    setOpen(false);
    setQuery('');
    setResults(IDLE_RESULTS);
    setActiveIdx(0);
    contextLoadingRef.current.clear();
    unmappableRef.current.clear();
    chaseSuspendedRef.current = false;
    findEngagedRef.current = false;
  }, [sessionId]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else {
      findEngagedRef.current = false;
      const previous = restoreFocusRef.current;
      if (previous?.isConnected) previous.focus();
      restoreFocusRef.current = null;
    }
  }, [open]);

  // A click or mousedown outside the find bar is the user leaving. A blur
  // whose next target is body/html is the transcript DOM being replaced, and
  // does not count — the restore below puts the caret back only then.
  useEffect(() => {
    if (!open) return;
    const leave = (event: Event) => {
      const target = event.target;
      const root = inputRef.current?.closest('.conv-find');
      if (!(target instanceof Node) || !root || !root.contains(target)) {
        findEngagedRef.current = false;
      }
    };
    // Tab into Composer, Browser/Files/Terminal search, or any other control
    // ends Find ownership. A later transcript swap must not pull focus back.
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      const root = inputRef.current?.closest('.conv-find');
      if (!root) {
        findEngagedRef.current = false;
        return;
      }
      if (target instanceof HTMLElement
        && target !== document.body
        && target !== document.documentElement
        && !root.contains(target)) {
        findEngagedRef.current = false;
      }
    };
    document.addEventListener('pointerdown', leave, true);
    document.addEventListener('mousedown', leave, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      document.removeEventListener('pointerdown', leave, true);
      document.removeEventListener('mousedown', leave, true);
      document.removeEventListener('focusin', onFocusIn, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !findEngagedRef.current) return;
    const input = inputRef.current;
    if (!input?.isConnected) return;
    const active = document.activeElement;
    if (active === input) return;
    const root = input.closest('.conv-find');
    if (!root) return;
    if (active instanceof Element && root.contains(active)) return;
    if (active instanceof HTMLElement && active !== document.body && active !== document.documentElement) return;
    input.focus();
  }, [open, items, domTick, locateGeneration]);

  // Debounced Host find over the persisted history. A USER query edit
  // clears the old matches up front. Stale responses drop on the generation
  // guard. (Same-query refreshes go through the refetch effect below.)
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      requestSeqRef.current += 1;
      locateAnchorRef.current = null;
      anchorRestartRef.current = 0;
      setResults(IDLE_RESULTS);
      setActiveIdx(0);
      return;
    }
    locateAnchorRef.current = null;
    anchorRestartRef.current = 0;
    setResults({ ...IDLE_RESULTS, status: 'loading' });
    setActiveIdx(0);
    const seq = ++requestSeqRef.current;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void findInSession(sessionId, { q, limit: FIND_PAGE_LIMIT }, controller.signal)
        .then(page => {
          if (requestSeqRef.current !== seq) return;
          setResults({
            status: 'ready',
            matches: page.matches,
            total: page.total,
            totalComplete: page.total_complete,
            nextCursor: page.next_cursor,
            partial: !page.coverage.complete,
            loadingMore: false,
          });
          contextLoadingRef.current.clear();
        })
        .catch(() => {
          if (controller.signal.aborted || requestSeqRef.current !== seq) return;
          setResults({ ...IDLE_RESULTS, status: 'error' });
        });
    }, FIND_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, sessionId]);

  // Same-query refresh (streaming drift, stale text revision, error retry).
  // Pages, totals, coverage, and cursors from this round stay together.
  // A hit the user was on that this page did not return is only an anchor:
  // later fresh cursors may confirm it. It is not copied into the new result.
  // A refresh bound to a locate intent does nothing once a newer Next,
  // Previous, or return-to-latest has moved on.
  useEffect(() => {
    if (refreshRequest.nonce === 0 || !open) return;
    const q = query.trim();
    if (!q) return;
    const locateSeq = refreshRequest.locateSeq;
    const seq = ++requestSeqRef.current;
    const stillThisRefresh = (anchorId?: string) => requestSeqRef.current === seq
      && (locateSeq === null || locateSeqRef.current === locateSeq)
      && (anchorId === undefined || locateAnchorRef.current === anchorId);
    const publish = (
      page: {
        matches: FindMatch[];
        total: number;
        total_complete: boolean;
        next_cursor: string | null;
        coverage: { complete: boolean };
      },
      matches: FindMatch[],
      nextCursor: string | null,
      index: number,
    ) => {
      if (requestSeqRef.current !== seq) return;
      if (locateSeq !== null && locateSeqRef.current !== locateSeq) return;
      setActiveIdx(index);
      setResults(freshFindResults(page, matches, nextCursor));
    };
    // Read the rest of THIS round until the anchor is returned or the fresh
    // cursor runs out. Stop on a repeated cursor or a second stale restart.
    const confirmAnchor = async (
      anchorId: string,
      matches: FindMatch[],
      cursor: string,
    ) => {
      const seen = new Set<string>();
      let acc = matches;
      let next: string | null = cursor;
      while (next) {
        if (seen.has(next) || !stillThisRefresh(anchorId)) return;
        seen.add(next);
        try {
          const page = await findInSession(sessionId, { q, limit: FIND_PAGE_LIMIT, cursor: next });
          if (!stillThisRefresh(anchorId)) return;
          acc = appendFreshMatches(acc, page.matches);
          let pageCursor = page.next_cursor;
          if (pageCursor && (pageCursor === next || seen.has(pageCursor))) pageCursor = null;
          const found = acc.findIndex(match => match.id === anchorId);
          if (found >= 0) {
            locateAnchorRef.current = null;
            anchorRestartRef.current = 0;
            publish(page, acc, pageCursor, found);
            return;
          }
          const provenDone = !pageCursor && page.total_complete && page.coverage.complete;
          if (provenDone) {
            locateAnchorRef.current = null;
            anchorRestartRef.current = 0;
            publish(page, acc, null, acc.length === 0 ? 0 : Math.min(activeIdxRef.current, acc.length - 1));
            return;
          }
          publish(page, acc, pageCursor, 0);
          if (!pageCursor) return;
          next = pageCursor;
        } catch (error) {
          if (!stillThisRefresh(anchorId)) return;
          if (error instanceof SearchApiError && error.code === 'stale_cursor') {
            setResults(previous => ({ ...previous, nextCursor: null, loadingMore: false }));
            if (anchorRestartRef.current >= 1) {
              locateAnchorRef.current = null;
              return;
            }
            anchorRestartRef.current += 1;
            requestQueryRefresh(null);
            return;
          }
          setResults(previous => ({ ...previous, loadingMore: false, status: 'error' }));
          return;
        }
      }
    };
    void findInSession(sessionId, { q, limit: FIND_PAGE_LIMIT })
      .then(page => {
        if (!stillThisRefresh()) return;
        const current = resultsRef.current;
        const selectedId = current.matches[activeIdxRef.current]?.id ?? null;
        const anchorId = locateAnchorRef.current ?? selectedId;
        const onPage = anchorId ? page.matches.findIndex(match => match.id === anchorId) : -1;
        if (anchorId && onPage >= 0) {
          locateAnchorRef.current = null;
          anchorRestartRef.current = 0;
          publish(page, page.matches, page.next_cursor, onPage);
          return;
        }
        const provenDone = !page.next_cursor && page.total_complete && page.coverage.complete;
        if (!anchorId || provenDone) {
          locateAnchorRef.current = null;
          anchorRestartRef.current = 0;
          const fallback = page.matches.length === 0
            ? 0
            : Math.min(activeIdxRef.current, page.matches.length - 1);
          publish(page, page.matches, page.next_cursor, fallback);
          return;
        }
        locateAnchorRef.current = anchorId;
        publish(page, page.matches, page.next_cursor, 0);
        if (page.next_cursor) void confirmAnchor(anchorId, page.matches, page.next_cursor);
      })
      .catch(() => {
        if (!stillThisRefresh()) return;
        setResults(previous => ({ ...previous, status: 'error' }));
      });
    // Only the refresh request re-fires this effect; query/session own the reset path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshRequest]);

  /** Continue scanning: the cursor binds the query/index Host-side; a 409
   *  stale cursor restarts the same query from the top. In-flight locked,
   *  generation-fenced, deduped by occurrence id. */
  const loadMoreMatches = useCallback(() => {
    const cursor = results.nextCursor;
    const q = query.trim();
    if (!cursor || results.loadingMore || results.status === 'loading') return;
    const knownIds = new Set(results.matches.map(match => match.id));
    const seq = requestSeqRef.current;
    setResults(previous => ({ ...previous, loadingMore: true }));
    void findInSession(sessionId, { q, limit: FIND_PAGE_LIMIT, cursor })
      .then(page => {
        if (requestSeqRef.current !== seq) return;
        // Growth is computed against the state at request start — not via a
        // setState updater side effect.
        const grew = page.matches.some(match => !knownIds.has(match.id));
        setResults(previous => ({
          ...previous,
          status: 'ready',
          loadingMore: false,
          matches: [...previous.matches, ...page.matches.filter(match => {
            const key = `${match.id}`;
            if (knownIds.has(key) || previous.matches.some(m => m.id === match.id)) return false;
            return true;
          })],
          total: page.total,
          totalComplete: page.total_complete,
          nextCursor: page.next_cursor,
          partial: !page.coverage.complete,
        }));
        if (pendingAdvanceRef.current) {
          pendingAdvanceRef.current = false;
          if (grew) setActiveIdx(index => index + 1);
        }
      })
      .catch(error => {
        if (requestSeqRef.current !== seq) return;
        pendingAdvanceRef.current = false;
        if (error instanceof SearchApiError && error.code === 'stale_cursor') {
          requestQueryRefresh(null);
          return;
        }
        setResults(previous => ({ ...previous, loadingMore: false, status: 'error' }));
      });
  }, [requestQueryRefresh, results.nextCursor, results.loadingMore, results.status, results.matches, query, sessionId]);

  // Streaming updates and window hydration change the DOM: rescan lazily.
  // The find bar's OWN overlay (find-atomic-active) never counts as content
  // change — otherwise marker append/remove would feed back into this
  // observer forever.
  useEffect(() => {
    const scope = scopeRef.current;
    if (!open || !scope) return;
    let frame = 0;
    const observer = new MutationObserver(mutations => {
      // Ignore only childList mutations whose changed nodes are entirely the
      // component's own overlay. characterData mutations carry no node lists
      // and MUST schedule — an empty .every would otherwise swallow them.
      const markerOnly = mutations.every(mutation =>
        mutation.type === 'childList'
        && (mutation.addedNodes.length + mutation.removedNodes.length) > 0
        && [...mutation.addedNodes, ...mutation.removedNodes].every(node =>
          node instanceof HTMLElement && node.classList.contains('find-atomic-active')));
      if (markerOnly) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setDomTick(tick => tick + 1));
    });
    observer.observe(scope, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [open, scopeRef]);

  // Canonical projections of the loaded window, recomputed on content change.
  const projections = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of items) {
      if (item.kind !== 'user' && item.kind !== 'assistant') continue;
      const projected = projectTranscriptItem(item);
      if (projected !== null) map.set(transcriptItemIdentity(item), projected);
    }
    return map;
  }, [items]);

  const activeMatch = results.status === 'ready' || results.status === 'loading'
    ? results.matches[activeIdx] ?? null
    : null;

  // An explicit return-to-latest generation wins during render, before the
  // highlight effect can start another context load or reveal the old hit.
  // A query or session edit clears the hold. The detached flag alone is not
  // the command.
  const returnGeneration = history?.returnToLatestGeneration ?? 0;
  const querySessionKey = `${sessionId}\0${query}`;
  const querySessionKeyRef = useRef(querySessionKey);
  if (querySessionKeyRef.current !== querySessionKey) {
    querySessionKeyRef.current = querySessionKey;
    chaseSuspendedRef.current = false;
  }
  if (returnWatchRef.current.sessionId !== sessionId) {
    returnWatchRef.current = { sessionId, generation: returnGeneration };
  } else if (returnGeneration !== returnWatchRef.current.generation) {
    if (returnGeneration > returnWatchRef.current.generation) {
      chaseSuspendedRef.current = true;
      locateSeqRef.current += 1;
      locateAnchorRef.current = null;
      anchorRestartRef.current = 0;
      contextLoadingRef.current.clear();
    }
    returnWatchRef.current.generation = returnGeneration;
  }

  /**
   * Map one Host match onto a DOM Range through exact projection alignment.
   * Returns 'stale' when the indexed range no longer matches the live text
   * (re-query), 'unmappable' when the rendered message cannot be aligned
   * (re-query), 'unmounted' when the message is outside the loaded window
   * (context load), or the mapped range (with its atomic anchor when the hit
   * is a whole visible element).
   */
  function mapMatch(scope: HTMLElement, match: FindMatch, q: string): MappedRange | 'stale' | 'unmappable' | 'unmounted' {
    const messageId = match.target.message_id;
    const projected = projections.get(messageId);
    const element = scope.querySelector<HTMLElement>(
      `[data-transcript-source-id="${CSS.escape(messageId)}"]`,
    );
    if (!element || projected === undefined) return 'unmounted';
    // The indexed range must still select the query in the live projection —
    // content edited since indexing makes this match stale, never re-mapped.
    const sliced = projected.slice(match.range.start, match.range.end);
    if (normalizeSearchText(sliced) !== normalizeSearchText(q)) return 'stale';
    const alignment = alignMessageToProjection(element, projected);
    if (!alignment) return 'unmappable';
    return rangeForProjectionRange(alignment.spans, match.range) ?? 'unmappable';
  }

  // Atomic hits (math, images) get an explicit, component-owned outline
  // overlay — the CSS Highlight of a selectNode range is not a guaranteed
  // visible marker on replaced elements. The marker lives INSIDE the
  // transcript scroller (position: relative — its containing block), so it
  // follows the element on manual scroll. It is REUSED across effect runs:
  // only coordinates re-measure, and only a new target element rebuilds —
  // the transcript MutationObserver never sees marker churn (and filters
  // it regardless). Measurement runs AFTER the reveal scroll; a
  // ResizeObserver re-measures on layout change. Message DOM and copy are
  // untouched; the marker never takes focus.
  const atomicMarkerRef = useRef<{
    marker: HTMLElement;
    observer: { disconnect(): void };
    element: HTMLElement;
  } | null>(null);
  const clearAtomicMarker = useCallback(() => {
    atomicMarkerRef.current?.observer.disconnect();
    atomicMarkerRef.current?.marker.remove();
    atomicMarkerRef.current = null;
  }, []);
  const showAtomicMarker = useCallback((scope: HTMLElement, element: HTMLElement) => {
    const measure = (marker: HTMLElement) => {
      const scopeRect = scope.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      marker.style.top = `${rect.top - scopeRect.top + scope.scrollTop}px`;
      marker.style.left = `${rect.left - scopeRect.left + scope.scrollLeft}px`;
      marker.style.width = `${rect.width}px`;
      marker.style.height = `${rect.height}px`;
    };
    const existing = atomicMarkerRef.current;
    if (existing && existing.element === element) {
      // Same target: coordinates only — no DOM churn, no observer feedback.
      measure(existing.marker);
      return;
    }
    clearAtomicMarker();
    const marker = document.createElement('div');
    marker.className = 'find-atomic-active';
    marker.dataset.testid = 'find-atomic-active';
    marker.tabIndex = -1;
    scope.appendChild(marker);
    measure(marker);
    const observer = typeof ResizeObserver !== 'undefined'
      ? (() => { const o = new ResizeObserver(() => measure(marker)); o.observe(element); return o; })()
      : { disconnect() {} };
    atomicMarkerRef.current = { marker, observer, element };
  }, [clearAtomicMarker]);

  // Highlight + reveal. Every Host match in the loaded window maps through
  // canonical alignment; failures never guess. Atomic hits get the explicit
  // outline marker.
  useEffect(() => {
    const scope = scopeRef.current;
    if (!open || !scope || !query.trim()) {
      setHighlights(HIGHLIGHT, []);
      setHighlights(ACTIVE_HIGHLIGHT, []);
      clearAtomicMarker();
      return;
    }
    const q = query.trim();
    let activeRange: Range | null = null;
    let activeAtomic: HTMLElement | null = null;
    let pendingUnmappable: string | null = null;
    let pendingContext: FindMatch | null = null;
    const passive: Range[] = [];
    for (const match of results.matches) {
      const mapped = mapMatch(scope, match, q);
      if (mapped === 'unmounted') {
        if (match === activeMatch) pendingContext = match;
        continue;
      }
      if (mapped === 'stale' || mapped === 'unmappable') {
        if (match === activeMatch) pendingUnmappable = match.id;
        continue;
      }
      passive.push(mapped.range);
      if (match === activeMatch) {
        activeRange = mapped.range;
        activeAtomic = mapped.atomicElement ?? null;
      }
    }
    // While a refresh is still confirming the user's anchor, the fresh page's
    // first hit must not scroll or start a context load.
    const holdAnchor = locateAnchorRef.current != null
      && activeMatch?.id !== locateAnchorRef.current;
    setHighlights(HIGHLIGHT, holdAnchor ? [] : passive);
    setHighlights(ACTIVE_HIGHLIGHT, !holdAnchor && activeRange ? [activeRange] : []);
    if (holdAnchor) {
      clearAtomicMarker();
      return;
    }
    if (activeRange) {
      // A suspended chase keeps the highlight but does not pull the tail
      // back to the hit the user just left.
      if (!chaseSuspendedRef.current) {
        revealTranscriptMatch(scope, activeRange);
        if (activeAtomic) showAtomicMarker(scope, activeAtomic);
        else clearAtomicMarker();
      } else {
        clearAtomicMarker();
      }
      return;
    }
    clearAtomicMarker();
    if (chaseSuspendedRef.current) return;
    if (pendingUnmappable) {
      // Re-query at most once per (query, message, text revision).
      const key = `${q}${pendingUnmappable}${activeMatch?.target.text_revision ?? ''}`;
      if (!unmappableRef.current.has(key)) {
        unmappableRef.current.add(key);
        requestQueryRefresh(locateSeqRef.current);
      }
      return;
    }
    if (pendingContext && onLoadMessageContext) {
      const match = pendingContext;
      if (contextLoadingRef.current.has(match.id)) return;
      const ticket = ++contextLoadTicketRef.current;
      contextLoadingRef.current.set(match.id, ticket);
      const seqAtEffect = requestSeqRef.current;
      const locateSeq = locateSeqRef.current;
      void onLoadMessageContext({
        turnId: match.target.turn_id,
        turn: match.target.turn,
        documentId: match.document_id,
        textRevision: match.target.text_revision,
      }).then(ok => {
        // Only this ticket may release the slot. A newer load of the same
        // match, or a repeated step that already took the slot, keeps its
        // lock. Failure refreshes only while this locate intent is still current.
        if (contextLoadingRef.current.get(match.id) !== ticket) return;
        contextLoadingRef.current.delete(match.id);
        if (locateSeqRef.current !== locateSeq) return;
        if (requestSeqRef.current !== seqAtEffect) return;
        if (!ok) requestQueryRefresh(locateSeq);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, results.matches, activeMatch, activeIdx, domTick, projections, sessionId, locateGeneration]);

  // Clear the highlights when the bar closes or unmounts.
  useEffect(() => {
    if (open) return;
    setHighlights(HIGHLIGHT, []);
    setHighlights(ACTIVE_HIGHLIGHT, []);
    clearAtomicMarker();
  }, [open, clearAtomicMarker]);
  useEffect(() => () => {
    setHighlights(HIGHLIGHT, []);
    setHighlights(ACTIVE_HIGHLIGHT, []);
    clearAtomicMarker();
  }, [clearAtomicMarker]);

  useEffect(() => {
    onActiveChange(open && query.trim().length > 0);
  }, [open, query, onActiveChange]);

  // Streaming drift: content changes re-run the open query (debounced), so
  // Host counts/matches stay consistent with the transcript instead of only
  // rescanning the DOM. A drift landing mid-load is queued, never dropped.
  const contentSignalRef = useRef(contentSignal);
  const pendingDriftRef = useRef(false);
  useEffect(() => {
    if (contentSignal === contentSignalRef.current) return;
    contentSignalRef.current = contentSignal;
    if (!open || !query.trim()) return;
    if (results.status === 'loading') {
      pendingDriftRef.current = true;
      return;
    }
    if (results.status !== 'ready') return;
    const timer = setTimeout(() => requestQueryRefresh(null), 400);
    return () => clearTimeout(timer);
  }, [contentSignal, open, query, requestQueryRefresh, results.status]);
  useEffect(() => {
    if (results.status === 'ready' && pendingDriftRef.current) {
      pendingDriftRef.current = false;
      requestQueryRefresh(null);
    }
  }, [requestQueryRefresh, results.status]);

  function move(direction: 1 | -1) {
    // The next explicit step is allowed to locate again, even when the
    // index wraps back onto the same match. Bumping the locate generation
    // retires a context load started for the previous step.
    chaseSuspendedRef.current = false;
    locateSeqRef.current += 1;
    locateAnchorRef.current = null;
    anchorRestartRef.current = 0;
    setLocateGeneration(generation => generation + 1);
    const count = results.matches.length;
    if (count === 0) {
      // A short query's first scan may return no rows with a live cursor —
      // continue scanning instead of pretending zero results.
      if (results.nextCursor) loadMoreMatches();
      return;
    }
    const next = activeIdx + direction;
    if (next < 0 || (next >= count && !results.nextCursor)) {
      // Wrapping reselects a loaded match. Drop the previous step's slot so
      // this one can load; leaving it held would block the retry.
      contextLoadingRef.current.clear();
      setActiveIdx(next < 0 ? count - 1 : 0);
      return;
    }
    if (next >= count) {
      // The page has not arrived, so the selection is still the old hit.
      // Keep its slot until it completes; the locate generation above is
      // what stops that completion from refreshing the query.
      pendingAdvanceRef.current = true;
      loadMoreMatches();
      return;
    }
    setActiveIdx(next);
  }

  if (!open) return null;

  const count = results.matches.length;
  const countLabel = results.status === 'loading' && count === 0
    ? '…'
    : count === 0
      ? `0 / ${results.totalComplete ? '0' : `${results.total}+`}`
      : `${activeIdx + 1} / ${results.totalComplete ? results.total : `${results.total}+`}`;
  const canStep = count > 0 || results.nextCursor !== null;

  return (
    <div className="conv-find" role="search" data-testid="conversation-find">
      <input
        ref={inputRef}
        className="conv-find-input"
        type="text"
        placeholder={t('find.placeholder')}
        aria-label={t('find.placeholder')}
        value={query}
        onFocus={() => { findEngagedRef.current = true; }}
        onBlur={event => {
          const next = event.relatedTarget;
          if (next instanceof Node && event.currentTarget.closest('.conv-find')?.contains(next)) return;
          if (next instanceof HTMLElement && next !== document.body && next !== document.documentElement) {
            findEngagedRef.current = false;
          }
        }}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            move(event.shiftKey ? -1 : 1);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
        }}
        autoComplete="off"
        spellCheck={false}
      />
      <span className="conv-find-count" data-testid="conversation-find-count">{countLabel}</span>
      {results.partial && (
        <span className="conv-find-partial" title={t('find.partial')} role="status">
          {t('find.partial')}
        </span>
      )}
      {history?.detachedFromLatest && (
        <span className="conv-find-partial" role="status">{t('find.windowed')}</span>
      )}
      {history?.historyIncomplete && (
        <span className="conv-find-partial" role="status">{t('find.historyIncomplete')}</span>
      )}
      {results.status === 'error' && (
        <button
          type="button"
          className="conv-find-partial conv-find-error"
          role="alert"
          data-testid="conversation-find-error"
          onClick={() => requestQueryRefresh(null)}
        >
          {t('find.error')} · {t('inbox.retry')}
        </button>
      )}
      <button
        type="button"
        className="conv-find-btn"
        data-testid="conversation-find-prev"
        title={t('find.previous')}
        aria-label={t('find.previous')}
        disabled={!canStep}
        onClick={() => move(-1)}
      >
        <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 14 6-6 6 6" />
        </svg>
      </button>
      <button
        type="button"
        className="conv-find-btn"
        data-testid="conversation-find-next"
        title={t('find.next')}
        aria-label={t('find.next')}
        disabled={!canStep}
        onClick={() => move(1)}
      >
        <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 10 6 6 6-6" />
        </svg>
      </button>
      <button
        type="button"
        className="conv-find-btn"
        data-testid="conversation-find-close"
        title={t('find.close')}
        aria-label={t('find.close')}
        onClick={close}
      >
        <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
