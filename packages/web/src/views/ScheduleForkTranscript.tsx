/**
 * Hidden Fork transcript (Issue #51 / ADR-0053 §3): a fork Run's target is a
 * real Session row with `hidden = 1` — it must NEVER enter the session rail,
 * Tasks, or any management list. This view therefore renders the transcript
 * inline inside the Schedule detail's panel-2 bounds (it replaces the detail
 * content in the same `.p2` aside): it pages `/api/sessions/:id/events`
 * (available for any session id), folds envelopes through the shared display
 * pipeline (applyEnvelope, same as transcript hydration), and renders a
 * read-only Transcript. Back returns to the Run log; nothing here touches
 * App's sessions state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Executor } from '@gian/shared';
import { useT } from '../i18n/index.js';
import { loadEvents } from '../api.js';
import { onScheduleChanged, onScheduleResync } from '../presentation/schedule-sync.js';
import { applyEnvelope } from '../transcript/apply.js';
import { transcriptItemIdentity } from '../transcript/identity.js';
import { Transcript } from '../transcript/Transcript.js';
import type { TranscriptItem } from '../types.js';

export function ScheduleForkTranscript({
  sessionId,
  runId,
  scheduleId,
  scheduleName,
  executor,
  onBack,
}: {
  sessionId: string;
  runId: string;
  scheduleId: string;
  scheduleName: string;
  executor: Executor;
  onBack: () => void;
}) {
  const t = useT();
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Center the transcript on THIS Run's scheduled user message once loaded.
  const [focusPending, setFocusPending] = useState(true);
  const generationRef = useRef(0);
  const hasLoadedRef = useRef(false);

  const loadFirstPage = useCallback(async (background = false) => {
    const generation = ++generationRef.current;
    setLoadingOlder(false);
    if (!background) {
      hasLoadedRef.current = false;
      setPhase('loading');
      setError(null);
    }
    try {
      const page = await loadEvents(sessionId);
      if (generation !== generationRef.current) return;
      setItems(page.events.reduce<TranscriptItem[]>(
        (current, event) => applyEnvelope(current, event, executor),
        [],
      ));
      setNextCursor(page.hasMore ? page.nextCursor : null);
      hasLoadedRef.current = true;
      setPhase('ready');
    } catch (thrown) {
      if (generation !== generationRef.current) return;
      if (background && hasLoadedRef.current) return;
      setError(thrown instanceof Error ? thrown.message : String(thrown));
      setPhase('error');
    }
  }, [sessionId, executor]);

  useEffect(() => {
    void loadFirstPage();
    return () => { generationRef.current += 1; };
  }, [loadFirstPage]);

  // Hidden Sessions are intentionally absent from the normal event
  // subscription. Run invalidations and reconnect syncs therefore re-pull the
  // transcript so a view opened while the Fork is running reaches its final
  // output without exposing the Session to the rail.
  useEffect(() => onScheduleChanged(message => {
    if (message.schedule_id === scheduleId && message.run_id === runId) {
      void loadFirstPage(true);
    }
  }), [loadFirstPage, runId, scheduleId]);
  useEffect(() => onScheduleResync(() => {
    void loadFirstPage(true);
  }), [loadFirstPage]);

  const loadOlder = useCallback(async () => {
    if (nextCursor === null || loadingOlder) return;
    const generation = generationRef.current;
    setLoadingOlder(true);
    try {
      const page = await loadEvents(sessionId, nextCursor);
      if (generation !== generationRef.current) return;
      const older = page.events.reduce<TranscriptItem[]>(
        (current, event) => applyEnvelope(current, event, executor),
        [],
      );
      setItems(previous => {
        const known = new Set(previous.map(transcriptItemIdentity));
        return [...older.filter(item => !known.has(transcriptItemIdentity(item))), ...previous];
      });
      setNextCursor(page.hasMore ? page.nextCursor : null);
    } catch {
      // Older-page failures keep the loaded transcript; the scroll affordance
      // simply stops (the cursor stays for a later retry via refresh).
    } finally {
      if (generation === generationRef.current) setLoadingOlder(false);
    }
  }, [sessionId, executor, nextCursor, loadingOlder]);

  return (
    <>
      <div className="p2-head schedule-detail-head">
        <button
          type="button"
          className="btn icon ghost"
          data-testid="schedule-fork-back"
          aria-label={t('timer.runs.backToRuns')}
          onClick={onBack}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <span className="p2-title schedule-detail-name">
          {t('timer.runs.forkTitle').replace('{name}', scheduleName)}
        </span>
      </div>
      <div className="p2-body schedule-fork-body" data-testid="schedule-fork-transcript">
        {phase === 'error' && (
          <div className="spaces-error" role="alert" data-testid="schedule-fork-error">
            <span>{error}</span>
            <button type="button" className="btn xs" onClick={() => void loadFirstPage()}>
              {t('timer.retry')}
            </button>
          </div>
        )}
        {phase === 'loading' && (
          <div className="timer-state" data-testid="schedule-fork-loading">
            <span className="spinner" />
            <span>{t('timer.loading')}</span>
          </div>
        )}
        {phase === 'ready' && (
          <Transcript
            items={items}
            pending={false}
            onApprove={() => undefined}
            hydrated
            hasOlder={nextCursor !== null}
            loadingOlder={loadingOlder}
            onLoadOlder={() => void loadOlder()}
            inlineEventDetails
            scheduleFocus={focusPending ? { runId } : null}
            onConsumeScheduleFocus={() => setFocusPending(false)}
          />
        )}
      </div>
    </>
  );
}
