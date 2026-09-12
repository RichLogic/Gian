/**
 * Composer (B5, §12.3). No Queue/Steer segmented control — the Owner cut it:
 * an active Turn always queues by default, steer goes through the Queue row's
 * Send now, and Send/Stop are ONE primary button (empty input + running turn
 * = Stop/danger, otherwise Send). Drafts are kept per session and survive
 * offline; while offline the draft stays editable but every mutation control
 * is disabled. On narrow layouts model/effort/mode collapse into a single
 * pill that opens a bottom sheet (mockup F18).
 */

import { useRef, useState } from 'react';
import type { RemoteSession } from '@gian/remote-protocol';
import type { EffectiveCapabilities } from '@gian/remote-protocol';
import { draftIsEmpty, emptyDraft, mutationsEnabled } from '../controller/types.js';
import type { DraftState } from '../controller/types.js';
import { useT } from '../i18n/index.js';
import { useRemoteActions, useRemoteState } from './controller-context.js';
import { Icon } from './icons.js';
import { useViewportMode } from './viewport.js';

function capabilityState(caps: EffectiveCapabilities, id: keyof EffectiveCapabilities) {
  return caps[id]?.state ?? 'unsupported';
}

function extraComposerSupported(
  caps: EffectiveCapabilities,
  id: 'composer.context' | 'composer.document',
): boolean {
  return (caps as Record<string, { state?: string } | undefined>)[id]?.state === 'supported';
}

function DraftChips({ sessionId, draft, disabled }: { sessionId: string; draft: DraftState; disabled: boolean }) {
  const actions = useRemoteActions();
  if (draft.attachments.length === 0 && draft.contextItems.length === 0 && !draft.document) return null;
  return (
    <div className="composer-chips">
      {draft.attachments.map((a) => (
        <span key={a.id} className="composer-chip" data-kind="attachment">
          <Icon name="file" size={12} />
          {a.name}
          <button
            type="button"
            className="chip-x"
            aria-label={`Remove ${a.name}`}
            disabled={disabled}
            onClick={() => actions.removeDraftAttachment(sessionId, a.id)}
          >
            ×
          </button>
        </span>
      ))}
      {draft.contextItems.map((c) => (
        <span key={c.id} className="composer-chip" data-kind="context">
          @ {c.label}
          <button
            type="button"
            className="chip-x"
            aria-label={`Remove ${c.label}`}
            disabled={disabled}
            onClick={() => actions.removeDraftContextItem(sessionId, c.id)}
          >
            ×
          </button>
        </span>
      ))}
      {draft.document && (
        <span className="composer-chip" data-kind="document">
          ▤ {draft.document.label}
          <button
            type="button"
            className="chip-x"
            aria-label={`Remove ${draft.document.label}`}
            disabled={disabled}
            onClick={() => actions.setDraftDocument(sessionId, null)}
          >
            ×
          </button>
        </span>
      )}
    </div>
  );
}

/** Attach menu — files go through the controller upload path; context and
 *  document still ask the controller for handles. */
function AttachMenu({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const [open, setOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const attachSupported = capabilityState(state.capabilities, 'attachment.upload') !== 'unsupported';
  const contextSupported = extraComposerSupported(state.capabilities, 'composer.context');
  const documentSupported = extraComposerSupported(state.capabilities, 'composer.document');
  if (!attachSupported && !contextSupported && !documentSupported) return null;
  return (
    <span className="composer-attach">
      <input
        ref={fileInput}
        type="file"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          void readPickedFile(file).then((bytes) => {
            actions.uploadDraftAttachment(sessionId, {
              name: file.name,
              mime: file.type || 'application/octet-stream',
              size: file.size || bytes.byteLength,
              bytes,
            });
          });
        }}
      />
      <button
        type="button"
        className="composer-act"
        title={t('chat.attach.title')}
        aria-label={t('chat.attach.title')}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="plus" size={14} />
      </button>
      {open && (
        <div className="composer-attach-menu" role="menu">
          {attachSupported && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                fileInput.current?.click();
              }}
            >
              {t('chat.attach.attachment')}
            </button>
          )}
          {contextSupported && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                actions.addDraftContextItem(sessionId, {
                  id: `ctx-${Date.now()}`,
                  kind: 'pasted_text',
                  label: 'context',
                });
              }}
            >
              {t('chat.attach.context')}
            </button>
          )}
          {documentSupported && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                actions.setDraftDocument(sessionId, { id: `doc-${Date.now()}`, label: 'document' });
              }}
            >
              {t('chat.attach.document')}
            </button>
          )}
        </div>
      )}
    </span>
  );
}

/** Compact session configuration menu. Model and Thinking drill into choice
 *  lists; Codex Fast stays an inline switch. Canonical values still arrive
 *  through session.updated after session.update settles. */
function ModelSheet({
  session,
  onClose,
  mode,
}: {
  session: RemoteSession;
  onClose: () => void;
  mode: 'wide' | 'mid' | 'narrow';
}) {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const [page, setPage] = useState<'root' | 'model' | 'thinking'>('root');
  const model = session.model || session.agent.name;
  const agent = state.catalog?.agents.find((candidate) => candidate.id === session.agent.id);
  const advertised = agent?.models ?? [];
  const models = advertised.some((candidate) => candidate.id === model)
    ? advertised
    : [{ id: model, label: model, is_default: false, supported_thinking: [] }, ...advertised];
  const selectedModel = models.find((candidate) => candidate.id === model)
    ?? advertised.find((candidate) => candidate.is_default)
    ?? advertised[0];
  const modelLabel = selectedModel?.label ?? model;
  const efforts = selectedModel?.supported_thinking ?? [];
  const thinking = session.thinking ?? null;
  const serviceTier = session.service_tier === 'fast' ? 'fast' : 'standard';
  const showMode = session.agent.proxy === 'codex';
  const catalogMutation = Object.values(state.mutations)
    .filter((mutation) => mutation.label === 'catalog.read')
    .sort((left, right) => right.startedAt - left.startedAt)[0];
  const catalogMissing = state.catalog === null || state.catalogInvalidated;
  const catalogReadable = capabilityState(state.capabilities, 'catalog.read') === 'supported';
  const loading = catalogMissing
    && catalogReadable
    && (!catalogMutation || catalogMutation.phase === 'pending');
  const updating = Object.values(state.mutations).some((mutation) => (
    mutation.label === 'session.update' && mutation.phase === 'pending'
  ));
  const canUpdate = mutationsEnabled(state.connection)
    && capabilityState(state.capabilities, 'session.update') === 'supported'
    && !updating;
  return (
    <div
      className={`rw-model-menu ${mode}`}
      role="menu"
      aria-label={t('chat.sheet.title')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      {page === 'root' && (
        <div className="rw-model-root">
          <button
            type="button"
            role="menuitem"
            className="rw-model-root-row"
            data-config-row="model"
            onClick={() => setPage('model')}
          >
            <span className="rw-model-root-label">{t('chat.sheet.model')}</span>
            <span className="rw-model-root-value">
              {loading ? t('chat.model.loading') : modelLabel}
            </span>
            <Icon name="caret-right" size={13} />
          </button>
          <button
            type="button"
            role="menuitem"
            className="rw-model-root-row"
            data-config-row="thinking"
            disabled={loading || efforts.length === 0}
            onClick={() => setPage('thinking')}
          >
            <span className="rw-model-root-label">{t('chat.sheet.effort')}</span>
            <span className="rw-model-root-value">{labelEffortValue(thinking ?? 'default')}</span>
            <Icon name="caret-right" size={13} />
          </button>
          {showMode && (
            <button
              type="button"
              role="switch"
              aria-label={t('chat.sheet.mode.fast')}
              aria-checked={serviceTier === 'fast'}
              className="rw-model-root-row rw-model-fast-row"
              data-config-row="fast"
              disabled={!canUpdate}
              onClick={() => {
                actions.updateSessionConfig(session.id, {
                  service_tier: serviceTier === 'fast' ? 'standard' : 'fast',
                });
              }}
            >
              <span className="rw-model-root-label">{t('chat.sheet.mode.fast')}</span>
              <span
                className={`rw-model-switch${serviceTier === 'fast' ? ' on' : ''}`}
                aria-hidden="true"
              >
                <span className="rw-model-switch-thumb" />
              </span>
            </button>
          )}
        </div>
      )}
      {page === 'model' && (
        <div className="rw-model-menu-section" role="group" aria-label={t('chat.sheet.model')}>
          <div className="rw-model-menu-head">
            <button
              type="button"
              className="btn icon xs ghost"
              aria-label={t('shell.back')}
              onClick={() => setPage('root')}
            >
              <Icon name="back" size={14} />
            </button>
            <span>{t('chat.sheet.model')}</span>
            <span className="rw-model-menu-head-spacer" aria-hidden="true" />
          </div>
          {loading && <div className="rw-model-menu-state" role="status">{t('chat.model.loading')}</div>}
          {!loading && models.length === 0 && (
            <div className="rw-model-menu-state">{t('chat.model.unavailable')}</div>
          )}
          {!loading && models.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="menuitemradio"
              aria-checked={candidate.id === model}
              className="rw-model-option"
              disabled={!canUpdate}
              onClick={() => {
                if (candidate.id !== model) actions.updateSessionConfig(session.id, { model: candidate.id });
                onClose();
              }}
            >
              <span className="rw-model-option-label">{candidate.label}</span>
              {candidate.label !== candidate.id && <span className="rw-model-option-id">{candidate.id}</span>}
              {candidate.id === model && <Icon name="check" size={13} />}
            </button>
          ))}
        </div>
      )}
      {page === 'thinking' && (
        <div className="rw-model-menu-section" role="group" aria-label={t('chat.sheet.effort')}>
          <div className="rw-model-menu-head">
            <button
              type="button"
              className="btn icon xs ghost"
              aria-label={t('shell.back')}
              onClick={() => setPage('root')}
            >
              <Icon name="back" size={14} />
            </button>
            <span>{t('chat.sheet.effort')}</span>
            <span className="rw-model-menu-head-spacer" aria-hidden="true" />
          </div>
          {efforts.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="menuitemradio"
              aria-checked={candidate === thinking}
              className="rw-model-option"
              disabled={!canUpdate}
              onClick={() => {
                if (candidate !== thinking) actions.updateSessionConfig(session.id, { thinking: candidate });
                onClose();
              }}
            >
              <span className="rw-model-option-label">{labelEffortValue(candidate)}</span>
              {candidate === thinking && <Icon name="check" size={13} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function labelConfigValue(value: string | null | undefined): string {
  if (!value) return 'Default';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const CODEX_EFFORT_LABELS: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Light',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
};

function labelEffortValue(value: string): string {
  return CODEX_EFFORT_LABELS[value] ?? labelConfigValue(value);
}

async function readPickedFile(file: File): Promise<Uint8Array> {
  try {
    if (typeof file.arrayBuffer === 'function') {
      return new Uint8Array(await file.arrayBuffer());
    }
    if (typeof FileReader !== 'undefined') {
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(new Uint8Array((reader.result as ArrayBuffer | null) ?? new ArrayBuffer(0)));
        reader.onerror = () => resolve(new Uint8Array());
        reader.readAsArrayBuffer(file);
      });
    }
  } catch {
    // jsdom File stubs may omit Blob I/O; production browsers always have arrayBuffer.
  }
  return new Uint8Array();
}

export function Composer({ session }: { session: RemoteSession }) {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const mode = useViewportMode();
  const [sheetOpen, setSheetOpen] = useState(false);

  const draft = state.drafts[session.id] ?? emptyDraft();
  const online = mutationsEnabled(state.connection);
  const running = Boolean(session.active_turn);
  const empty = draftIsEmpty(draft);
  // Merged primary button: empty input + running turn = Stop, else Send.
  const isStop = running && empty;
  const sendCapable = capabilityState(state.capabilities, 'session.send') === 'supported';
  const stopCapable = capabilityState(state.capabilities, 'session.stop') === 'supported';
  const primaryCapable = isStop ? stopCapable : sendCapable;
  const sendPending = Object.values(state.mutations).some(
    (m) => m.phase === 'pending' && (m.label === 'session.send' || m.label === 'session.stop'),
  );
  const model = session.model || session.agent.name;
  const effort = labelEffortValue(session.thinking ?? 'default');

  const placeholder = !online
    ? t('chat.placeholder.offline')
    : running
      ? t('chat.placeholder.busy')
      : t('chat.placeholder.idle');

  return (
    <div className="composer-wrap">
      <div className="composer">
        <DraftChips sessionId={session.id} draft={draft} disabled={false} />
        <div className="composer-input-wrap">
          <textarea
            className="composer-input"
            aria-label={placeholder}
            placeholder={placeholder}
            rows={2}
            value={draft.text}
            onChange={(event) => actions.setDraftText(session.id, event.target.value)}
            onKeyDown={(event) => {
              // IME-friendly: Enter sends, Shift+Enter inserts a newline.
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!isStop) actions.sendDraft(session.id);
              }
            }}
          />
        </div>
        <div className="composer-bar">
          <button
            type="button"
            className="composer-model"
            title={t('chat.model.title')}
            aria-expanded={sheetOpen}
            onClick={() => {
              setSheetOpen((current) => !current);
              if (!state.catalog || state.catalogInvalidated) actions.refreshCatalog();
            }}
          >
            <span className="rw-agent-dot" data-proxy={session.agent.proxy} aria-hidden="true" />
            <span className="name">{model}{mode === 'narrow' ? ` · ${effort}` : ''}</span>
            <span className="caret">▾</span>
          </button>
          <span className="spacer" style={{ flex: 1 }} />
          <AttachMenu sessionId={session.id} disabled={!online} />
          <button
            type="button"
            className={`composer-act primary${isStop ? ' danger' : ''}`}
            title={isStop ? t('chat.stop.title') : t(running ? 'chat.send.title.busy' : 'chat.send.title')}
            aria-label={isStop ? t('chat.stop.title') : t(running ? 'chat.send.title.busy' : 'chat.send.title')}
            disabled={!online || !primaryCapable || sendPending || (!isStop && empty)}
            onClick={() => {
              if (isStop) actions.stopSession(session.id);
              else actions.sendDraft(session.id);
            }}
          >
            <Icon name={isStop ? 'stop' : 'send'} size={13} />
          </button>
        </div>
      </div>
      {sheetOpen && (
        <ModelSheet session={session} onClose={() => setSheetOpen(false)} mode={mode} />
      )}
    </div>
  );
}
