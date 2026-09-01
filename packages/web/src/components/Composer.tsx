import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ApprovalMode, ComposerDocument, ComposerReferenceSegment, ConfigOption, ConfigValue, Executor, MessageContextItem, PickComposerResourcesResult, NativeConfigValue, ProxyModeCapabilities, Session, SlashCommand, ThinkingEffort } from '@gian/shared';
import { MAX_MESSAGE_CONTEXT_ITEMS, MAX_PASTED_TEXT_BYTES, composerDocumentUserText, isApprovalMode, normalizeBrowserElementCapture, normalizeComposerDocument, usesCliCapabilitySurface, usesNativeExecutorConfig } from '@gian/shared';
import { MAX_FILE_BYTES, dedupeAttachmentName, fmtBytes, isNativeImageMime, servedAttachmentUrl } from '../attachments.js';
import type { UploadedAttachment } from '../api.js';
import {
  loadNativeConfig,
  loadResolvedProxyCatalog,
  loadSessionSlashCommands,
} from '../api.js';
import { desktopBridge } from '../desktop-bridge.js';
import { useT } from '../i18n/index.js';
// Runtime import (not `import type`): registering message.uploadAttachment
// on the product registry is a module side effect.
import { type UploadAttachmentInput } from '../operations/message.js';
import {
  useOperationDispatchOptional,
  useOperationStoreOptional,
  useSessionOperationPending,
  waitForRunSettle,
} from '../operations/use-operations.js';
import '../operations/context.js';
import { ImageZoomContext } from '../transcript/items.js';
import { publishScreenshotTarget } from '../screenshot-target.js';
import { ContextUsageIndicator } from './composer/context-usage-indicator.js';
import {
  ContextReferencePopover,
  REFERENCE_ICONS,
  ReferencePopover,
  ReferencePopoverHead,
} from './composer/reference-popover.js';
import type { ReferenceAnchor } from './composer/reference-popover.js';
import {
  InlineComposerEditor,
  type InlineComposerEditorHandle,
} from './composer/InlineComposerEditor.js';
import {
  applyResolvedDefaults,
  claudeModelFamily,
  composerConfigValues,
  composerModeLabel,
  composerModeOptions,
  defaultEffort,
  defaultModel,
  effortLabel,
  fetchCatalogCached,
  fetchModelsCached,
  fetchModesCached,
  fetchSteerCached,
  fetchSlashCached,
  flatFiltered,
  getCatalogCached,
  getModelsCached,
  getModesCached,
  getSlashCached,
  inputTypeAdvertised,
  mergeTurnCatalog,
  displayModelsFromCatalog,
  optionByRole,
  optionEnabled,
  optionVisible,
  SLASH_CACHE_INVALIDATED_EVENT,
  modelLabel,
  nativeOptionRole,
  slashFilterGrouped,
  supportedEfforts,
} from './composer/capabilities.js';
import type { ProxyModel } from './composer/capabilities.js';
import { NativeOptionDrop, useUpDrop } from './composer/option-drops.js';
export { ContextUsageIndicator } from './composer/context-usage-indicator.js';

/** v4 adds an ordered text/reference document to v3 resources. */
const DRAFT_KEY_PREFIX = 'gian.composer.draft.v4.';
const V3_DRAFT_KEY_PREFIX = 'gian.composer.draft.v3.';
const V2_DRAFT_KEY_PREFIX = 'gian.composer.draft.v2.';
const LEGACY_DRAFT_KEY_PREFIX = 'gian.composer.draft.v1.';
const draftKey = (sessionId: string) => `${DRAFT_KEY_PREFIX}${sessionId}`;
const v3DraftKey = (sessionId: string) => `${V3_DRAFT_KEY_PREFIX}${sessionId}`;
const v2DraftKey = (sessionId: string) => `${V2_DRAFT_KEY_PREFIX}${sessionId}`;
const legacyDraftKey = (sessionId: string) => `${LEGACY_DRAFT_KEY_PREFIX}${sessionId}`;
const PASTED_TEXT_CARD_MIN_CHARS = 800;
const PASTED_TEXT_CARD_MIN_LINES = 8;

export interface DraftAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** Absolute path in the host attachment store (upload already done). */
  path: string;
}

interface ComposerDraft {
  text: string;
  document: ComposerDocument;
  attachments: DraftAttachment[];
  contextItems: MessageContextItem[];
}

const EMPTY_DOCUMENT: ComposerDocument = { version: 1, segments: [] };
const EMPTY_DRAFT: ComposerDraft = {
  text: '',
  document: EMPTY_DOCUMENT,
  attachments: [],
  contextItems: [],
};

function contextReferenceLabel(item: MessageContextItem): string {
  if (item.type === 'folder') return item.name;
  if (item.type === 'browserElement') return item.name || item.selector;
  const preview = item.text.replace(/\s+/g, ' ').trim();
  return preview.slice(0, 80) || 'Pasted text';
}

function composerReferenceIds(document: ComposerDocument): Set<string> {
  return new Set(document.segments.flatMap(segment => (
    segment.type === 'reference' ? [segment.id] : []
  )));
}

function legacyDocument(
  text: string,
  attachments: DraftAttachment[],
  contextItems: MessageContextItem[],
): ComposerDocument {
  const segments: ComposerDocument['segments'] = [];
  const references: ComposerReferenceSegment[] = [
    ...attachments.map(attachment => ({
      type: 'reference' as const,
      id: attachment.id,
      referenceType: 'attachment' as const,
      label: attachment.name,
    })),
    ...contextItems.map(item => ({
      type: 'reference' as const,
      id: item.id,
      referenceType: 'context' as const,
      label: contextReferenceLabel(item),
    })),
  ];
  references.forEach((reference, index) => {
    segments.push(reference);
    if (index < references.length - 1 || text) segments.push({ type: 'text', text: '\n' });
  });
  if (text) segments.push({ type: 'text', text });
  return normalizeComposerDocument({ version: 1, segments }) ?? EMPTY_DOCUMENT;
}

function appendReference(
  document: ComposerDocument,
  reference: Omit<ComposerReferenceSegment, 'type'>,
): ComposerDocument {
  if (document.segments.some(segment => segment.type === 'reference' && segment.id === reference.id)) {
    return document;
  }
  return normalizeComposerDocument({
    version: 1,
    segments: [...document.segments, { type: 'reference', ...reference }, { type: 'text', text: ' ' }],
  }) ?? document;
}

function draftContextItems(value: unknown): MessageContextItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): MessageContextItem[] => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.id !== 'string') return [];
    if (candidate.type === 'folder') {
      return typeof candidate.path === 'string' && typeof candidate.name === 'string'
        ? [candidate as unknown as MessageContextItem]
        : [];
    }
    if (candidate.type === 'pastedText'
      && typeof candidate.text === 'string'
      && typeof candidate.lineCount === 'number'
      && typeof candidate.byteSize === 'number') {
      return [candidate as unknown as MessageContextItem];
    }
    if (candidate.type === 'browserElement') {
      const capture = normalizeBrowserElementCapture(candidate);
      return capture ? [{ type: 'browserElement', id: candidate.id, ...capture }] : [];
    }
    return [];
  }).slice(0, MAX_MESSAGE_CONTEXT_ITEMS);
}

function readDraft(sessionId: string): ComposerDraft {
  try {
    const raw = localStorage.getItem(draftKey(sessionId))
      ?? localStorage.getItem(v3DraftKey(sessionId))
      ?? localStorage.getItem(v2DraftKey(sessionId));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ComposerDraft>;
      const contextItems = draftContextItems(parsed.contextItems);
      const attachments = Array.isArray(parsed.attachments)
        ? parsed.attachments.flatMap((attachment): DraftAttachment[] => {
            if (
              !attachment
              || typeof attachment.path !== 'string'
              || typeof attachment.name !== 'string'
              || typeof attachment.mime !== 'string'
            ) return [];
            return [{
              id: typeof attachment.id === 'string' ? attachment.id : crypto.randomUUID(),
              path: attachment.path,
              name: attachment.name,
              mime: attachment.mime,
              size: typeof attachment.size === 'number' ? attachment.size : 0,
            }];
          })
        : [];
      const text = typeof parsed.text === 'string' ? parsed.text : '';
      return {
        text,
        document: normalizeComposerDocument(parsed.document)
          ?? legacyDocument(text, attachments, contextItems),
        attachments,
        contextItems,
      };
    }
    // Legacy v1 draft (plain text) — carried over once, then rewritten as v2.
    const legacy = localStorage.getItem(legacyDraftKey(sessionId));
    return legacy
      ? { text: legacy, document: legacyDocument(legacy, [], []), attachments: [], contextItems: [] }
      : EMPTY_DRAFT;
  } catch {
    return EMPTY_DRAFT;
  }
}
function writeDraft(sessionId: string, draft: ComposerDraft): void {
  try {
    if (draft.document.segments.length > 0 || draft.attachments.length > 0 || draft.contextItems.length > 0) {
      localStorage.setItem(draftKey(sessionId), JSON.stringify(draft));
    } else {
      localStorage.removeItem(draftKey(sessionId));
    }
    localStorage.removeItem(legacyDraftKey(sessionId));
    localStorage.removeItem(v2DraftKey(sessionId));
    localStorage.removeItem(v3DraftKey(sessionId));
  } catch {
    // localStorage may be unavailable (privacy mode) — drafts become ephemeral.
  }
}

/** Window event the Composer listens for to pick up an externally-injected
 *  draft (e.g. the Changes inspector dropping a "commit and push" prompt into
 *  the active session's input for the user to review before sending). */
const COMPOSER_INJECT_EVENT = 'gian:composer-inject';
let pendingComposerFocusSessionId: string | null = null;

/** Append `text` to the given session's draft and notify a mounted Composer
 *  to re-read it. The text is NOT auto-sent — it lands in the textarea so the
 *  user can edit/confirm. Appends (with a blank line) rather than clobbering an
 *  existing draft. */
export function injectComposerDraft(sessionId: string, text: string): void {
  const existing = readDraft(sessionId);
  const next = existing.text ? `${existing.text}\n\n${text}` : text;
  const document = normalizeComposerDocument({
    version: 1,
    segments: [
      ...existing.document.segments,
      ...(existing.document.segments.length > 0 ? [{ type: 'text' as const, text: '\n\n' }] : []),
      { type: 'text' as const, text },
    ],
  }) ?? existing.document;
  writeDraft(sessionId, { ...existing, text: next, document });
  try {
    window.dispatchEvent(new CustomEvent(COMPOSER_INJECT_EVENT, {
      detail: { sessionId, kind: 'text' },
    }));
  } catch {
    // no window (SSR/tests) — the draft is still persisted for next mount.
  }
}

/** Add an already-uploaded screenshot to one exact Session draft. */
export function injectComposerAttachment(
  sessionId: string,
  attachment: Pick<UploadedAttachment, 'path' | 'name' | 'mime' | 'size'>,
): void {
  const existing = readDraft(sessionId);
  const existingAttachment = existing.attachments.find(item => item.path === attachment.path);
  const nextAttachment: DraftAttachment = {
    id: existingAttachment?.id ?? crypto.randomUUID(),
    path: attachment.path,
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size,
  };
  const attachments = [
    ...existing.attachments.filter(item => item.path !== attachment.path),
    nextAttachment,
  ];
  writeDraft(sessionId, {
    ...existing,
    attachments,
    document: appendReference(existing.document, {
      id: nextAttachment.id,
      referenceType: 'attachment',
      label: nextAttachment.name,
    }),
  });
  pendingComposerFocusSessionId = sessionId;
  try {
    window.dispatchEvent(new CustomEvent(COMPOSER_INJECT_EVENT, {
      detail: { sessionId, kind: 'attachment', attachment: nextAttachment },
    }));
  } catch {
    // The draft and focus request are consumed when the Composer next mounts.
  }
}

/** Restore Gian-owned context cards into an existing Session draft. */
export function injectComposerContextItems(
  sessionId: string,
  contextItems: MessageContextItem[],
): boolean {
  if (contextItems.length === 0) return true;
  const existing = readDraft(sessionId);
  const byId = new Map(existing.contextItems.map(item => [item.id, item]));
  for (const item of contextItems) byId.set(item.id, item);
  if (byId.size > MAX_MESSAGE_CONTEXT_ITEMS) return false;
  writeDraft(sessionId, {
    ...existing,
    contextItems: [...byId.values()],
    document: contextItems.reduce((document, item) => appendReference(document, {
      id: item.id,
      referenceType: 'context',
      label: contextReferenceLabel(item),
    }), existing.document),
  });
  pendingComposerFocusSessionId = sessionId;
  try {
    window.dispatchEvent(new CustomEvent(COMPOSER_INJECT_EVENT, {
      detail: { sessionId, kind: 'context', contextItems },
    }));
  } catch {
    // The draft is consumed when the Composer next mounts.
  }
  return true;
}

/** Restore an ordered draft after only part of a pre-session attachment batch
 *  uploaded. The caller has already removed failed attachment references. */
export function injectComposerDocumentDraft(
  sessionId: string,
  documentValue: ComposerDocument,
  attachments: DraftAttachment[],
  injectedContextItems: MessageContextItem[],
): void {
  const existing = readDraft(sessionId);
  const document = normalizeComposerDocument({
    version: 1,
    segments: [
      ...existing.document.segments,
      ...(existing.document.segments.length > 0 && documentValue.segments.length > 0
        ? [{ type: 'text' as const, text: '\n\n' }]
        : []),
      ...documentValue.segments,
    ],
  }) ?? existing.document;
  const attachmentById = new Map(existing.attachments.map(item => [item.id, item]));
  for (const attachment of attachments) attachmentById.set(attachment.id, attachment);
  const contextById = new Map(existing.contextItems.map(item => [item.id, item]));
  for (const item of injectedContextItems) contextById.set(item.id, item);
  writeDraft(sessionId, {
    text: composerDocumentUserText(document),
    document,
    attachments: [...attachmentById.values()],
    contextItems: [...contextById.values()],
  });
  pendingComposerFocusSessionId = sessionId;
  try {
    window.dispatchEvent(new CustomEvent(COMPOSER_INJECT_EVENT, {
      detail: { sessionId, kind: 'text' },
    }));
  } catch {
    // The durable draft and focus request are consumed on the next mount.
  }
}

/** Delete an unsent draft owned by a newly-created transient route. */
export function discardComposerDraft(sessionId: string): void {
  try {
    localStorage.removeItem(draftKey(sessionId));
    localStorage.removeItem(v2DraftKey(sessionId));
    localStorage.removeItem(v3DraftKey(sessionId));
    localStorage.removeItem(legacyDraftKey(sessionId));
  } catch {
    // localStorage may be unavailable; there is no persisted draft to clean.
  }
  if (pendingComposerFocusSessionId === sessionId) pendingComposerFocusSessionId = null;
}

interface PendingFile {
  /** Local id so React keys are stable even when name is duplicated. */
  id: string;
  /** Display filename (paste auto-generates `paste-{timestamp}.png`). */
  name: string;
  /** MIME from the source File — echoed up to App so the user_message item
   *  can carry it alongside the path. */
  mime: string;
  size: number;
  sizeLabel: string;
  /** Object URL for thumbnail preview. Composer revokes when the user
   *  removes the chip; on send, ownership transfers to App which revokes
   *  during user_message reconciliation. */
  previewUrl: string;
  /** Absolute path returned by the upload endpoint, or null while uploading. */
  path: string | null;
  /** True while the POST is in flight. */
  uploading: boolean;
  /** Set when the upload fails so the chip can show the error state. */
  error?: string;
}

/** Rebuild composer chips from a persisted draft. The upload already happened
 *  (path is set), so the chip previews from the host-served URL — no object
 *  URL is created and `URL.revokeObjectURL` on it is a harmless no-op. */
function draftAttachmentsToPending(sessionId: string, attachments: DraftAttachment[]): PendingFile[] {
  return attachments.map(a => ({
    id: a.id,
    name: a.name,
    mime: a.mime,
    size: a.size,
    sizeLabel: fmtBytes(a.size),
    previewUrl: servedAttachmentUrl(sessionId, a.path),
    path: a.path,
    uploading: false,
  }));
}

/** Attachments worth persisting into the draft: fully uploaded, no error. */
function persistableDraftAttachments(files: PendingFile[]): DraftAttachment[] {
  return files
    .filter((f): f is PendingFile & { path: string } => f.path !== null && !f.uploading && !f.error)
    .map(f => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, path: f.path }));
}

function ControlSeparator() {
  return <span className="cmp-control-sep" aria-hidden="true">|</span>;
}

/** A concrete Claude id like `claude-opus-4-8` (synced from the native
 *  session) maps to its `opus`/`sonnet`/`haiku` alias family so the static
 *  alias menu can still highlight the matching row. Returns the input
 *  unchanged when it isn't a recognizable concrete claude id. */
export function Composer({
  session,
  onSend, onSendSkill, onStop, onQueueAdd, onSteer, onSetMode, onSetModel, onSetEffort,
  onSetNativeConfig, onSetTurnConfig, onSetServiceTier, canSteer,
  disabled, running, executor, agentId = null,
  workspaceId,
  footer,
  disabledSubmitBehavior = 'queue',
  variant = 'full',
  placeholder,
  busyPlaceholder,
}: {
  session: Session;
  onSend: (
    text: string,
    opts?: {
      oneShotBypass?: boolean;
      /** Uploaded attachments for this turn. App owns the `previewUrl`s from
       *  this point — Composer must NOT revoke them; the optimistic echo
       *  reuses them until the server confirms with permanent URLs. */
      attachments?: Array<{
        path: string;
        name: string;
        mime: string;
        size: number;
        previewUrl: string;
      }>;
      contextItems?: MessageContextItem[];
      composerDocument?: ComposerDocument;
    },
  ) => void;
  /** Dispatch a skill invocation directly (used for codex user/project skills
   *  — bypasses the input box so the skill runs as a structured input item
   *  rather than being sent as text). */
  onSendSkill: (name: string, path: string) => void;
  onStop: () => void;
  onQueueAdd: (
    text: string,
    attachments?: Array<{ path: string; name: string; mime: string; size?: number }>,
    contextItems?: MessageContextItem[],
    composerDocument?: ComposerDocument,
  ) => void;
  /** Mid-turn injection (`turn.steer`): Ctrl+Enter while a turn is running
   *  appends the draft to the ACTIVE turn instead of queueing it. Driven by
   *  the Proxy `turn.steer` capability via `canSteer`, not by executor id. */
  onSteer?: (
    text: string,
    opts?: {
      attachments?: Array<{ path: string; name: string; mime: string; size?: number }>;
      contextItems?: MessageContextItem[];
      composerDocument?: ComposerDocument;
    },
  ) => void;
  onSetMode: (mode: ApprovalMode) => void;
  onSetModel: (model: string) => void;
  onSetEffort: (effort: ThinkingEffort | null) => void;
  onSetNativeConfig?: (configId: string, value: NativeConfigValue) => void;
  onSetTurnConfig?: (optionId: string, value: ConfigValue) => void;
  /** Shown when the catalog advertises `role=fast`, or as the Codex fallback
   *  until that option arrives. */
  onSetServiceTier?: (tier: 'fast' | null) => void;
  /** True when the attached Proxy advertised `turn.steer`. When omitted,
   *  Composer reads initialize capabilities from the executor catalog
   *  endpoint and falls back to the historical Codex-only behavior. */
  canSteer?: boolean;
  disabled: boolean;
  /** A turn is actually in flight — drives the Send→Stop toggle. Distinct
   *  from `disabled`, which also covers lock-out / pending-question. */
  running: boolean;
  disabledSubmitBehavior?: 'queue' | 'block';
  executor: Executor;
  /** Owning Agent of the session — scopes capability caches to its CLI
   *  path; undefined resolves through the kind default. */
  agentId?: string | null;
  workspaceId?: string;
  footer?: import('react').ReactNode;
  /** Restricted variants omit attachment, bypass, slash and screenshot
   *  actions. `fixed` renders all config as inherited; `sidechat` makes only
   *  Proxy-advertised Turn-bound controls interactive. */
  variant?: 'full' | 'fixed' | 'sidechat';
  /** Override the idle placeholder text (defaults to `composer.placeholder.idle`). */
  placeholder?: string;
  /** Override the DISABLED placeholder (defaults to `composer.placeholder.busy`,
   *  which mentions queueing — wrong for surfaces without a queue, e.g. the
   *  Side Chat dock whose disabled-submit behavior is 'block'). */
  busyPlaceholder?: string;
}) {
  const t = useT();
  const fixed = variant !== 'full';
  const configurableSidechat = variant === 'sidechat';
  const hardDisabled = disabled && disabledSubmitBehavior === 'block';
  const cliExecutor = usesCliCapabilitySurface(executor) ? executor : null;
  const zoomImage = useContext(ImageZoomContext);
  // Restore text AND already-uploaded attachments from the per-session draft —
  // before v2 only the text survived a session switch and the chips vanished
  // even though their uploads still existed in the host attachment store.
  const [initialDraft] = useState(() => readDraft(session.id));
  const [composerDocument, setComposerDocument] = useState(initialDraft.document);
  const [text, setText] = useState(() => composerDocumentUserText(initialDraft.document));
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>(
    () => draftAttachmentsToPending(session.id, initialDraft.attachments),
  );
  const [contextItems, setContextItems] = useState<MessageContextItem[]>(initialDraft.contextItems);

  // Session swap: snapshot current draft under the OUTGOING session's key,
  // then load the INCOMING session's draft. We use the React-blessed
  // "adjust state during render" pattern so the textarea never paints the
  // outgoing draft against the incoming session id.
  const lastSessionRef = useRef(session.id);
  /** Monotonic generation for catalog.resolve requests; stale responses are
   *  dropped so an older model's overlay can never win a race. */
  const resolveGenerationRef = useRef(0);
  if (lastSessionRef.current !== session.id) {
    // Switching sessions invalidates every in-flight catalog.resolve: the
    // old session's overlay must never bleed into the new session's menu.
    resolveGenerationRef.current += 1;
    const referencedIds = composerReferenceIds(composerDocument);
    writeDraft(lastSessionRef.current, {
      text,
      document: composerDocument,
      attachments: persistableDraftAttachments(pendingFiles.filter(file => referencedIds.has(file.id))),
      contextItems: contextItems.filter(item => referencedIds.has(item.id)),
    });
    for (const f of pendingFiles) URL.revokeObjectURL(f.previewUrl);
    const incoming = readDraft(session.id);
    lastSessionRef.current = session.id;
    setText(composerDocumentUserText(incoming.document));
    setComposerDocument(incoming.document);
    setPendingFiles(draftAttachmentsToPending(session.id, incoming.attachments));
    setContextItems(incoming.contextItems);
  }
  // Single-turn bypass: ⚡ button toggles. Cleared automatically after the
  // next send so it never persists across turns.
  const [oneShotBypass, setOneShotBypass] = useState(false);
  const addDrop = useUpDrop(220, { align: 'right' });
  const [activeReference, setActiveReference] = useState<{
    id: string;
    anchor: ReferenceAnchor;
    anchorEl: HTMLElement;
  } | null>(null);
  const [resourcePicking, setResourcePicking] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashDismissedInput, setSlashDismissedInput] = useState<{
    sessionId: string;
    text: string;
  } | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashLoading, setSlashLoading] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>(
    () => cliExecutor
      ? (getSlashCached(cliExecutor, workspaceId, agentId) ?? [])
      : [],
  );
  const [slashRefreshVersion, setSlashRefreshVersion] = useState(0);
  const [slashPopPos, setSlashPopPos] = useState<{ left: number; bottom: number; width: number } | null>(null);
  // Approval stays independent; every other catalog option lives in the
  // single Cursor-style options menu rendered in the composer bar.
  const approvalDrop = useUpDrop(340, { align: 'right' });
  const modelDrop = useUpDrop(320);
  const thinkDrop = useUpDrop(210);
  const [models, setModels] = useState<ProxyModel[]>(
    cliExecutor ? (getModelsCached(cliExecutor, agentId) ?? []) : [],
  );
  const [proxyModes, setProxyModes] = useState<ProxyModeCapabilities[]>(
    cliExecutor ? (getModesCached(cliExecutor, agentId) ?? []) : [],
  );
  const [fetchedSteer, setFetchedSteer] = useState<boolean | undefined>(undefined);
  const [catalog, setCatalog] = useState(() => getCatalogCached(executor, agentId) ?? {
    configOptions: [],
    input: [],
    slashCommands: [],
  });
  const [resolvedOverlay, setResolvedOverlay] = useState<{
    options?: ConfigOption[];
    defaults?: Record<string, ConfigValue>;
    error?: string | null;
  } | null>(null);

  function handleDocumentChange(nextDocument: ComposerDocument, userText: string): void {
    setSlashDismissedInput(null);
    setComposerDocument(nextDocument);
    setText(userText);
    const referenceIds = composerReferenceIds(nextDocument);
    if (activeReference && !referenceIds.has(activeReference.id)) setActiveReference(null);
  }
  const steerEnabled = canSteer ?? fetchedSteer ?? executor === 'codex';
  const sessionNativeOptions = session.native_config_options ?? [];
  const [nativeOptions, setNativeOptions] = useState(sessionNativeOptions);
  // Pending session.stop run (Phase 2a): the Stop button flips to a stable
  // "stopping" state immediately and duplicate clicks are blocked — both by
  // this disabled state and by the dispatcher's duplicate pending guard.
  const stopping = useSessionOperationPending(session.id, 'session.stop');
  // Operation dispatch for attachment uploads (Phase 2b,
  // message.uploadAttachment). Null only when no operation provider is
  // mounted (standalone test renders) — uploads then fail the chip visibly.
  const dispatch = useOperationDispatchOptional();
  const operationStore = useOperationStoreOptional();
  const screenshotAvailable = !!desktopBridge()?.screenshot;
  const resourcePickerAvailable = !!desktopBridge()?.resources;

  // Fetch model list lazily per executor; cached.
  useEffect(() => {
    if (!cliExecutor) {
      setModels([]);
      return;
    }
    const cached = getModelsCached(cliExecutor, agentId);
    if (cached) {
      setModels(cached);
      return;
    }
    let alive = true;
    void fetchModelsCached(cliExecutor, agentId)
      .then(list => { if (alive) setModels(list); })
      .catch(() => {
        // Keep rendering the session with its persisted model/effort. The
        // capability menu can retry the next time this executor is mounted.
        if (alive) setModels([]);
      });
    return () => { alive = false; };
  }, [cliExecutor]);

  // Fetch the session-mode vocabulary lazily per executor; cached. Until it
  // resolves (or if it fails) the mode dropdown uses the built-in lists.
  useEffect(() => {
    if (!cliExecutor) {
      setProxyModes([]);
      return;
    }
    const cached = getModesCached(cliExecutor, agentId);
    if (cached) {
      setProxyModes(cached);
      return;
    }
    let alive = true;
    void fetchModesCached(cliExecutor, agentId)
      .then(list => { if (alive) setProxyModes(list); })
      .catch(() => {
        // Keep rendering the built-in mode lists; the fetch retries the next
        // time this executor's composer is mounted.
        if (alive) setProxyModes([]);
      });
    return () => { alive = false; };
  }, [cliExecutor]);

  useEffect(() => {
    const cached = getCatalogCached(executor, agentId);
    if (cached) {
      setCatalog(cached);
      return;
    }
    let alive = true;
    void fetchCatalogCached(executor, agentId)
      .then(next => {
        if (!alive) return;
        setCatalog(next);
      })
      .catch(() => {
        if (!alive) return;
        setCatalog({ configOptions: [], input: [], slashCommands: [] });
      });
    return () => { alive = false; };
  }, [executor]);

  useEffect(() => {
    if (canSteer !== undefined) {
      setFetchedSteer(undefined);
      return;
    }
    let alive = true;
    void fetchSteerCached(executor, agentId)
      .then(advertised => { if (alive) setFetchedSteer(advertised); })
      .catch(() => { if (alive) setFetchedSteer(undefined); });
    return () => { alive = false; };
  }, [executor, agentId, canSteer]);

  useEffect(() => {
    setResolvedOverlay(null);
  }, [session.id, executor]);

  const catalogReady = catalog.configOptions.length > 0
    || session.turn_config_options !== undefined;
  const showNativeFallback = !catalogReady && usesNativeExecutorConfig(executor);

  // Fetch slash commands lazily; keyed by (executor, workspaceId); cached.
  useEffect(() => {
    // The fixed variant has no slash UI — skip session slash discovery
    // entirely (for a Side Chat composer the per-session REST endpoint does
    // not even exist on the route).
    if (fixed) return;
    if (catalogReady) {
      let alive = true;
      setSlashCommands(catalog.slashCommands);
      setSlashLoading(true);
      void loadSessionSlashCommands(session.id)
        .then(list => {
          if (!alive) return;
          setSlashCommands(list);
          setSlashLoading(false);
        })
        .catch(() => {
          if (!alive) return;
          setSlashCommands(catalog.slashCommands);
          setSlashLoading(false);
        });
      return () => { alive = false; };
    }
    if (usesNativeExecutorConfig(executor)) {
      let alive = true;
      setSlashCommands([]);
      setSlashLoading(true);
      void loadSessionSlashCommands(session.id)
        .then(list => {
          if (!alive) return;
          setSlashCommands(list);
          setSlashLoading(false);
        })
        .catch(() => {
          if (!alive) return;
          setSlashCommands([]);
          setSlashLoading(false);
        });
      return () => { alive = false; };
    }
    if (!usesCliCapabilitySurface(executor)) {
      // Catalog-driven agents without a resolved catalog (e.g. the ZCode
      // bootstrap) expose no CLI slash surface at all.
      setSlashCommands([]);
      setSlashLoading(false);
      return;
    }
    const cached = getSlashCached(executor, workspaceId, agentId);
    if (cached) {
      setSlashCommands(cached);
      setSlashLoading(false);
      return;
    }
    let alive = true;
    // Never render commands from the previous executor/workspace while this
    // key is loading. Without the reset, a fast `/` could expose and invoke a
    // command belonging to the session the user just left.
    setSlashCommands([]);
    setSlashLoading(true);
    void fetchSlashCached(executor, workspaceId, agentId)
      .then(list => {
        if (!alive) return;
        setSlashCommands(list);
        setSlashLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setSlashCommands([]);
        setSlashLoading(false);
      });
    return () => { alive = false; };
  }, [catalogReady, catalog.slashCommands, executor, agentId, fixed, session.id, workspaceId, slashRefreshVersion]);

  useEffect(() => {
    if (catalogReady || !usesCliCapabilitySurface(executor) || !workspaceId) return;
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent).detail as { workspaceId?: unknown } | undefined;
      if (detail?.workspaceId === workspaceId) {
        setSlashRefreshVersion(version => version + 1);
      }
    };
    window.addEventListener(SLASH_CACHE_INVALIDATED_EVENT, refresh);
    return () => window.removeEventListener(SLASH_CACHE_INVALIDATED_EVENT, refresh);
  }, [catalogReady, executor, workspaceId]);

  useEffect(() => {
    if (catalogReady || !usesNativeExecutorConfig(executor)) return;
    const update = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { sessionId?: unknown; commands?: unknown }
        | undefined;
      if (detail?.sessionId !== session.id || !Array.isArray(detail.commands)) return;
      setSlashCommands(detail.commands as SlashCommand[]);
    };
    window.addEventListener('gian:session-slash-commands', update);
    return () => window.removeEventListener('gian:session-slash-commands', update);
  }, [catalogReady, executor, session.id]);

  useEffect(() => {
    setNativeOptions(sessionNativeOptions);
  }, [session.id, session.native_config_options]);

  useEffect(() => {
    if (fixed || !showNativeFallback || sessionNativeOptions.length > 0) return;
    let alive = true;
    void loadNativeConfig(session.id)
      .then(snapshot => {
        if (alive && snapshot) setNativeOptions(snapshot.options);
      })
      .catch(() => {
        // Session content remains usable while native config is unavailable.
      });
    return () => { alive = false; };
  }, [fixed, showNativeFallback, executor, session.id, sessionNativeOptions.length]);

  const mergedOptions = mergeTurnCatalog(catalog.configOptions, session.turn_config_options);
  const viewOptions = resolvedOverlay?.options ?? mergedOptions;
  const configValues = applyResolvedDefaults(
    composerConfigValues(session, viewOptions),
    resolvedOverlay?.defaults,
  );
  const catalogModelOption = optionByRole(viewOptions, 'model')
    ?? optionByRole(mergedOptions, 'model');
  const catalogEffortOption = optionByRole(viewOptions, 'effort');
  const catalogApprovalOption = optionByRole(viewOptions, 'approval_mode');
  const displayModels = displayModelsFromCatalog(
    optionByRole(viewOptions, 'model'),
    optionByRole(mergedOptions, 'model'),
    models,
  );
  const catalogEfforts = (catalogEffortOption?.choices ?? []).map(choice => String(choice.value));
  const currentModel = session.model
    ?? (catalogModelOption && catalogModelOption.defaultValue != null
      ? String(catalogModelOption.defaultValue)
      : (models.length > 0 && cliExecutor ? defaultModel(models, cliExecutor) : ''));
  // Fall back to the default (or first) entry when the active model isn't in
  // the menu — e.g. a concrete id like `claude-opus-4-8` synced from native state
  // that the static alias list doesn't enumerate. Without this the effort grid
  // (keyed off the matched row's supportedEfforts) would render empty.
  const currentModelMeta = displayModels.find(m => m.model === currentModel)
    ?? displayModels.find(m => m.isDefault)
    ?? displayModels[0];
  const explicitThinkLevel = session.thinking_effort;
  const thinkLevel = explicitThinkLevel
    ?? (catalogEffortOption && catalogEffortOption.defaultValue != null
      ? String(catalogEffortOption.defaultValue)
      : defaultEffort(currentModelMeta));
  const nativeModelOption = nativeOptions.find(option =>
    nativeOptionRole(option) === 'model' && option.type === 'select');
  const nativeEffortOption = nativeOptions.find(option =>
    nativeOptionRole(option) === 'effort' && option.type === 'select');
  const nativeModeOption = nativeOptions.find(option =>
    nativeOptionRole(option) === 'mode' && option.type === 'select');
  const fastOption = viewOptions.find(option => option.role === 'fast' && option.binding === 'turn');
  const showFast = (fixed || Boolean(onSetServiceTier)) && (
    fastOption
      ? optionVisible(fastOption, configValues)
      : !catalogReady && executor === 'codex'
  );
  const fastEnabled = !fastOption || optionEnabled(fastOption, configValues);
  const canAttachLocalFile = catalog.input.length === 0
    || inputTypeAdvertised(catalog, 'localFile', configValues);
  const canAttachLocalImage = catalog.input.length === 0
    || inputTypeAdvertised(catalog, 'localImage', configValues);
  // Files are uploaded into the host-owned per-session attachment store before
  // send, so queued turns and restored sessions never depend on the original.
  // (pendingFiles itself is declared up top — the session-swap block needs it.)
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<InlineComposerEditorHandle>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Persist the draft on every text / attachment change so refreshes,
  // accidental closes and session switches don't lose unsent input. The
  // session-swap render-time block above already swaps state to the incoming
  // session's draft, so this effect always writes against the current
  // session id.
  useEffect(() => {
    const referencedIds = composerReferenceIds(composerDocument);
    writeDraft(session.id, {
      text,
      document: composerDocument,
      attachments: persistableDraftAttachments(pendingFiles.filter(file => referencedIds.has(file.id))),
      contextItems: contextItems.filter(item => referencedIds.has(item.id)),
    });
  }, [session.id, text, composerDocument, pendingFiles, contextItems]);

  useEffect(() => {
    editorRef.current?.setDocument(composerDocument);
    // Only session replacement is externally controlled; ordinary edits are
    // owned by Lexical and flow upward through onChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  // External draft injection covers text prompts and screenshots captured while
  // this Session was either foregrounded or temporarily unmounted.
  useEffect(() => {
    function onInject(e: Event) {
      const detail = (e as CustomEvent).detail as {
        sessionId?: string;
        kind?: 'text' | 'attachment' | 'context';
        attachment?: DraftAttachment;
        contextItems?: MessageContextItem[];
      } | undefined;
      if (detail?.sessionId !== session.id) return;
      if (detail.kind === 'attachment' && detail.attachment) {
        setPendingFiles(previous => {
          if (previous.some(file => file.path === detail.attachment!.path)) return previous;
          return [
            ...previous,
            ...draftAttachmentsToPending(session.id, [detail.attachment!]),
          ];
        });
        editorRef.current?.insertReference({
          id: detail.attachment.id,
          referenceType: 'attachment',
          label: detail.attachment.name,
        });
      } else if (detail.kind === 'context') {
        const incoming = readDraft(session.id);
        setContextItems(incoming.contextItems);
        for (const item of detail.contextItems ?? []) {
          editorRef.current?.insertReference({
            id: item.id,
            referenceType: 'context',
            label: contextReferenceLabel(item),
          });
        }
      } else {
        const incoming = readDraft(session.id);
        setText(composerDocumentUserText(incoming.document));
        setComposerDocument(incoming.document);
        editorRef.current?.setDocument(incoming.document);
      }
      requestAnimationFrame(() => {
        editorRef.current?.focus();
        if (pendingComposerFocusSessionId === session.id) pendingComposerFocusSessionId = null;
      });
    }
    window.addEventListener(COMPOSER_INJECT_EVENT, onInject);
    if (pendingComposerFocusSessionId === session.id) {
      requestAnimationFrame(() => {
        if (!editorRef.current) return;
        editorRef.current.focus();
        if (pendingComposerFocusSessionId === session.id) pendingComposerFocusSessionId = null;
      });
    }
    return () => window.removeEventListener(COMPOSER_INJECT_EVENT, onInject);
  }, [session.id]);

  useEffect(() => {
    // Fixed composers (Side Chat dock) are not screenshot targets — the
    // attachment store is keyed to real Sessions.
    if (fixed || hardDisabled || !screenshotAvailable) return;
    return publishScreenshotTarget({
      kind: 'session',
      sessionId: session.id,
      label: session.name?.trim() || `session ${session.id.slice(0, 6)}`,
    });
  }, [fixed, hardDisabled, screenshotAvailable, session.id, session.name]);

  const activeModel = catalogModelOption
    ? String(configValues[catalogModelOption.id] ?? currentModel)
    : currentModel;
  const approvalValue = catalogApprovalOption
    ? String(configValues[catalogApprovalOption.id] ?? session.approval_mode ?? catalogApprovalOption.defaultValue ?? '')
    : (session.approval_mode ?? 'ask');
  const catalogModeList = catalogApprovalOption?.choices?.map(choice => ({
    id: String(choice.value),
    label: choice.displayName,
    description: choice.description ?? '',
    isDefault: Object.is(choice.value, catalogApprovalOption.defaultValue),
  }));
  const modeOptions = catalogModeList && catalogModeList.length > 0
    ? composerModeOptions(executor, catalogModeList)
    : (cliExecutor ? composerModeOptions(cliExecutor, proxyModes) : []);
  const showModelChip = catalogReady
    ? Boolean(catalogModelOption && optionVisible(catalogModelOption, configValues))
    : Boolean(cliExecutor);
  const showEffortChip = catalogReady
    ? Boolean(catalogEffortOption && optionVisible(catalogEffortOption, configValues))
    : Boolean(cliExecutor);
  const showApprovalChip = catalogReady
    ? Boolean(catalogApprovalOption && optionVisible(catalogApprovalOption, configValues))
    : Boolean(cliExecutor);
  const effortChoices = catalogEfforts.length > 0
    ? catalogEfforts
    : supportedEfforts(currentModelMeta);
  const modelControlInteractive = !fixed || Boolean(
    configurableSidechat && catalogModelOption?.binding === 'turn' && onSetModel,
  );
  const effortControlInteractive = !fixed || Boolean(
    configurableSidechat && catalogEffortOption?.binding === 'turn' && onSetEffort,
  );
  const fastControlInteractive = !fixed || Boolean(
    configurableSidechat && fastOption?.binding === 'turn' && onSetServiceTier,
  );
  const approvalControlInteractive = !fixed || Boolean(
    configurableSidechat && catalogApprovalOption?.binding === 'turn' && onSetMode,
  );
  const modelControlVisible = fixed
    ? modelControlInteractive ? showModelChip : showModelChip || Boolean(activeModel)
    : Boolean((showNativeFallback && nativeModelOption) || showModelChip);
  const effortControlVisible = fixed
    ? effortControlInteractive ? showEffortChip : showEffortChip || Boolean(thinkLevel)
    : Boolean((showNativeFallback && nativeEffortOption) || showEffortChip);
  const fastControlVisible = fixed ? showFast : Boolean(showFast && onSetServiceTier);

  function replaceEditorText(nextText: string): void {
    const nextDocument = normalizeComposerDocument({
      version: 1,
      segments: nextText ? [{ type: 'text', text: nextText }] : [],
    }) ?? EMPTY_DOCUMENT;
    setText(nextText);
    setComposerDocument(nextDocument);
    editorRef.current?.setDocument(nextDocument);
  }

  function clearEditor(): void {
    setText('');
    setComposerDocument(EMPTY_DOCUMENT);
    editorRef.current?.clear();
  }

  const hasReferences = composerDocument.segments.some(segment => segment.type === 'reference');
  const liveReferenceIds = composerReferenceIds(composerDocument);

  const slashPrefix = !hasReferences && text.startsWith('/') ? text : '';
  const filteredGroups = slashOpen ? slashFilterGrouped(slashCommands, slashPrefix) : [];
  const filtered = flatFiltered(filteredGroups);

  useEffect(() => {
    // Fixed variant has no slash UI — never auto-open the popover.
    if (fixed || hardDisabled) {
      setSlashOpen(false);
      return;
    }
    // Escape/outside-click explicitly dismisses this exact input. Discovery
    // can finish after the dismissal and update `slashCommands`; do not let
    // that asynchronous update reopen the popover until the user edits.
    if (slashDismissedInput?.sessionId === session.id
      && slashDismissedInput.text === text) return;
    // Auto-open / auto-filter the popover based on what the user types.
    // Empty input is a no-op. Typing `/` is the only entry point; the visible
    // slash button was intentionally removed from the composer.
    if (text === '/') {
      setSlashOpen(true);
      setSlashIdx(0);
    } else if (text.startsWith('/') && text.length > 1) {
      const groups = slashFilterGrouped(slashCommands, text);
      if (groups.length > 0) {
        setSlashOpen(true);
        setSlashIdx(0);
      } else {
        setSlashOpen(false);
      }
    } else if (text.length > 0) {
      // Non-slash text → close. Empty text is a no-op (button-controlled).
      setSlashOpen(false);
    }
  }, [text, slashCommands, fixed, hardDisabled, session.id, slashDismissedInput]);

  useEffect(() => {
    if (!slashOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (
        popRef.current && !popRef.current.contains(e.target as Node) &&
        editorRef.current?.rootElement()
        && !editorRef.current.rootElement()!.contains(e.target as Node)
      ) {
        setSlashDismissedInput({ sessionId: session.id, text });
        setSlashOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [slashOpen, session.id, text]);

  // Position the slash popover relative to the composer's bounding rect.
  // Portaled to body so it escapes `.composer { overflow: hidden }`.
  useLayoutEffect(() => {
    if (!slashOpen) { setSlashPopPos(null); return; }
    const composer = editorRef.current?.rootElement()?.closest('.composer') as HTMLElement | null;
    if (!composer) return;
    const rect = composer.getBoundingClientRect();
    setSlashPopPos({
      left: rect.left,
      bottom: window.innerHeight - rect.top + 4,
      width: rect.width,
    });
  }, [slashOpen]);

  function pickCommand(cmd: SlashCommand) {
    // Codex typed skills bypass submit(), so a popup that was open when the
    // session became completed needs an explicit fail-closed guard.
    if (hardDisabled) {
      setSlashOpen(false);
      return;
    }
    // Codex user/project skills dispatch as a typed input item directly —
    // codex resolves the skill markdown and runs it. Native commands and cc
    // commands fall back to the text-into-input path so the user can edit
    // args before sending.
    const skillAdvertised = catalog.input.length === 0
      ? executor === 'codex'
      : inputTypeAdvertised(catalog, 'skill', configValues);
    const isCodexSkill = skillAdvertised
      && (cmd.source === 'user' || cmd.source === 'project')
      && !!cmd.filePath;
    if (isCodexSkill) {
      setSlashOpen(false);
      clearEditor();
      onSendSkill(cmd.name.replace(/^\//, ''), cmd.filePath!);
      return;
    }

    replaceEditorText(cmd.name + ' ');
    setSlashOpen(false);
    requestAnimationFrame(() => editorRef.current?.focus());
  }

  function submit() {
    const trimmed = composerDocumentUserText(composerDocument).trim();
    const referenceIds = composerReferenceIds(composerDocument);
    const referencedPendingFiles = pendingFiles.filter(file => referenceIds.has(file.id));
    const referencedContextItems = contextItems.filter(item => referenceIds.has(item.id));
    // Wait for in-flight uploads to land before sending. We allow the send if
    // there's any text OR at least one ready attachment.
    const ready = referencedPendingFiles.filter(f => !f.uploading && !f.error && f.path);
    if (!trimmed && ready.length === 0 && referencedContextItems.length === 0) return;
    if (referencedPendingFiles.some(f => f.uploading)) return; // inline reference spinner indicates wait
    if (referencedPendingFiles.some(f => f.error)) return;

    const attachments = ready.map(f => ({
      path: f.path!,
      name: f.name,
      mime: f.mime,
      size: f.size,
      previewUrl: f.previewUrl,
    }));
    if (disabled) {
      if (disabledSubmitBehavior === 'block') return;
      const queuedAttachments = attachments.map(({ path, name, mime, size }) => ({ path, name, mime, size }));
      onQueueAdd(
        trimmed,
        queuedAttachments,
        referencedContextItems.length > 0 ? referencedContextItems : undefined,
        hasReferences ? composerDocument : undefined,
      );
      // Queue path doesn't transfer ownership — revoke previews now.
      for (const f of pendingFiles) URL.revokeObjectURL(f.previewUrl);
    } else {
      const opts: {
        oneShotBypass?: true;
        attachments?: Array<{ path: string; name: string; mime: string; size: number; previewUrl: string }>;
        contextItems?: MessageContextItem[];
        composerDocument?: ComposerDocument;
      } = {};
      if (oneShotBypass) opts.oneShotBypass = true;
      if (attachments.length > 0) opts.attachments = attachments;
      if (referencedContextItems.length > 0) opts.contextItems = referencedContextItems;
      if (hasReferences) opts.composerDocument = composerDocument;
      onSend(trimmed, Object.keys(opts).length > 0 ? opts : undefined);
      if (oneShotBypass) setOneShotBypass(false);
      // App owns the sent attachments' previewUrls now — revoke only the
      // unsent ones (failed uploads / still in flight when user pressed
      // send was blocked above, so this is the failed-upload subset).
      const sentIds = new Set(ready.map(f => f.id));
      for (const f of pendingFiles) {
        if (!sentIds.has(f.id)) URL.revokeObjectURL(f.previewUrl);
      }
    }
    setPendingFiles([]);
    setContextItems([]);
    clearEditor();
  }

  /** Codex ⌘/Ctrl+Enter-while-running: append the draft to the ACTIVE turn via
   *  `turn/steer` instead of queueing it for the next one. Same payload
   *  discipline as submit() — wait for uploads, carry attachments, clear the
   *  draft. No optimistic echo; the host records the user message on the
   *  active turn and broadcasts it back. */
  function steerSubmit() {
    if (!onSteer) return;
    const trimmed = composerDocumentUserText(composerDocument).trim();
    const referenceIds = composerReferenceIds(composerDocument);
    const referencedPendingFiles = pendingFiles.filter(file => referenceIds.has(file.id));
    const referencedContextItems = contextItems.filter(item => referenceIds.has(item.id));
    const ready = referencedPendingFiles.filter(f => !f.uploading && !f.error && f.path);
    if (!trimmed && ready.length === 0 && referencedContextItems.length === 0) return;
    if (referencedPendingFiles.some(f => f.uploading)) return;
    if (referencedPendingFiles.some(f => f.error)) return;
    const attachments = ready.map(f => ({
      path: f.path!,
      name: f.name,
      mime: f.mime,
      size: f.size,
    }));
    const steerOptions = {
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(referencedContextItems.length > 0 ? { contextItems: referencedContextItems } : {}),
      ...(hasReferences ? { composerDocument } : {}),
    };
    onSteer(trimmed, Object.keys(steerOptions).length > 0 ? steerOptions : undefined);
    for (const f of pendingFiles) URL.revokeObjectURL(f.previewUrl);
    setPendingFiles([]);
    setContextItems([]);
    clearEditor();
  }

  function maybeResolve(nextTurn: Record<string, ConfigValue>): void {
    if (!catalog.resolveAdvertised || !catalog.catalogRevision) return;
    const generation = ++resolveGenerationRef.current;
    const sessionConfig: Record<string, ConfigValue> = {};
    for (const option of mergedOptions) {
      if (option.binding !== 'session') continue;
      const value = configValues[option.id];
      if (value !== undefined) sessionConfig[option.id] = value;
    }
    void loadResolvedProxyCatalog(executor, {
      catalogRevision: catalog.catalogRevision,
      sessionConfig,
      turnConfig: nextTurn,
      sessionId: session.id,
    }).then((resolved) => {
      if (resolveGenerationRef.current !== generation) return;
      setResolvedOverlay({
        options: mergeTurnCatalog(resolved.configOptions, undefined),
        defaults: {
          ...resolved.resolvedDefaults.sessionConfig,
          ...resolved.resolvedDefaults.turnConfig,
        },
        error: null,
      });
    }).catch((error: unknown) => {
      // A failed resolve must keep the previous overlay's menu; only the
      // error surfaces (and only if this request is still the latest one).
      if (resolveGenerationRef.current !== generation) return;
      setResolvedOverlay((previous) => ({
        ...(previous ?? {}),
        error: error instanceof Error ? error.message : String(error),
      }));
    });
  }

  function setMode(mode: ApprovalMode | string) {
    if (catalogApprovalOption) {
      setCatalogOption(catalogApprovalOption, mode);
      return;
    }
    if (isApprovalMode(mode)) onSetMode(mode);
  }

  function setNativeConfigValue(configId: string, value: NativeConfigValue) {
    setNativeOptions(current => current.map(option =>
      option.id === configId ? { ...option, currentValue: value } : option));
    onSetNativeConfig?.(configId, value);
  }

  function setCatalogOption(option: ConfigOption, value: ConfigValue) {
    if (option.role === 'model') {
      onSetModel(String(value ?? ''));
      const nextValues = { ...configValues, [option.id]: value };
      if (
        fastOption
        && session.service_tier === 'fast'
        && (!optionVisible(fastOption, nextValues) || !optionEnabled(fastOption, nextValues))
      ) {
        onSetServiceTier?.(null);
      }
      // A model change invalidates the previous model's effort value: never
      // send the stale effort to catalog.resolve (the proxy rejects unknown
      // model/effort combinations). Drop it from the resolve request; the
      // resolved default replaces it in the overlay.
      const effortId = mergedOptions.find(candidate => candidate.role === 'effort')?.id;
      const resolveTurn: Record<string, ConfigValue> = {
        ...(session.turn_config ?? {}),
        [option.id]: value,
      };
      if (effortId) delete resolveTurn[effortId];
      maybeResolve(resolveTurn);
      return;
    }
    else if (option.role === 'effort') onSetEffort(value == null ? null : String(value));
    else if (option.role === 'approval_mode') {
      if (isApprovalMode(value) && !usesNativeExecutorConfig(executor)) onSetMode(value);
      else onSetTurnConfig?.(option.id, value);
    } else if (option.role === 'fast') onSetServiceTier?.(value === true ? 'fast' : null);
    else onSetTurnConfig?.(option.id, value);
    maybeResolve({ ...(session.turn_config ?? {}), [option.id]: value });
  }

  // Check if there are ready attachments (uploaded, no errors).
  const canSendAttachmentOnly = pendingFiles.some(
    f => liveReferenceIds.has(f.id) && !f.uploading && !f.error && f.path,
  );
  const canSendContextOnly = contextItems.some(item => liveReferenceIds.has(item.id));

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(e.target.files ?? []);
    for (const file of chosen) void uploadOne(file);
    // Reset input so the same file can be re-selected
    e.target.value = '';
  }

  function removeFile(id: string) {
    editorRef.current?.removeReference(id);
    setPendingFiles(prev => {
      const target = prev.find(f => f.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter(f => f.id !== id);
    });
  }

  function removeContextItem(id: string) {
    editorRef.current?.removeReference(id);
    setContextItems(previous => previous.filter(item => item.id !== id));
    setContextError(null);
  }

  async function pickComposerResources() {
    addDrop.setOpen(false);
    setResourcePicking(true);
    setContextError(null);
    try {
      if (!dispatch || !operationStore) {
        setContextError(t('composer.context.pickerUnavailable'));
        return;
      }
      const run = dispatch('context.pickResources', {});
      const settled = await waitForRunSettle(operationStore, run.id);
      if (settled.phase !== 'confirmed') {
        setContextError(t('composer.context.pickerUnavailable'));
        return;
      }
      const result = settled.result as PickComposerResourcesResult | undefined;
      if (!result) return;
      if (result.rejectedFiles.length > 0) {
        setContextError(t('composer.context.filesRejected'));
      }
      const paths = new Set(contextItems.flatMap(item => item.type === 'folder' ? [item.path] : []));
      const additions = result.resources
        .filter(resource => resource.type === 'folder')
        .flatMap(folder => {
          if (paths.has(folder.path)) return [];
          paths.add(folder.path);
          return [{
            type: 'folder' as const,
            id: crypto.randomUUID(),
            path: folder.path,
            name: folder.name,
          }];
        })
        .slice(0, Math.max(0, MAX_MESSAGE_CONTEXT_ITEMS - contextItems.length));
      if (additions.length > 0) {
        setContextItems(previous => [...previous, ...additions]);
        for (const item of additions) {
          editorRef.current?.insertReference({
            id: item.id,
            referenceType: 'context',
            label: item.name,
          });
        }
        requestAnimationFrame(() => editorRef.current?.focus());
      }
      for (const resource of result.resources) {
        if (resource.type !== 'file') continue;
        if (canAttachLocalFile || (canAttachLocalImage && isNativeImageMime(resource.mime))) {
          uploadOne(new File(
            [new Uint8Array(resource.data)],
            resource.name,
            { type: resource.mime },
          ));
        }
      }
    } finally {
      setResourcePicking(false);
    }
  }

  function uploadOne(file: File): void {
    const id = crypto.randomUUID();
    const previewUrl = URL.createObjectURL(file);
    const entry: PendingFile = {
      id,
      name: file.name,
      mime: file.type,
      size: file.size,
      sizeLabel: fmtBytes(file.size),
      previewUrl,
      path: null,
      uploading: file.size <= MAX_FILE_BYTES,
      ...(file.size > MAX_FILE_BYTES
        ? { error: t('composer.attachment.tooLarge') }
        : {}),
    };
    setPendingFiles(prev => [...prev, entry]);
    editorRef.current?.insertReference({
      id,
      referenceType: 'attachment',
      label: file.name,
    });
    requestAnimationFrame(() => editorRef.current?.focus());
    if (file.size > MAX_FILE_BYTES) return;
    if (!dispatch) {
      // No operation provider (standalone render) — fail the chip visibly
      // rather than silently dropping the upload.
      setPendingFiles(prev =>
        prev.map(f => f.id === id ? { ...f, uploading: false, error: t('composer.attachment.uploadUnavailable') } : f),
      );
      return;
    }

    // The pending-file chip UX is unchanged: `uploading` drives the spinner,
    // onFailed sets the error flag. The operation layer correlates the run.
    dispatch<UploadAttachmentInput>('message.uploadAttachment', {
      sessionId: session.id,
      blob: file,
      filename: file.name,
      onUploaded: result =>
        setPendingFiles(prev =>
          prev.map(f => f.id === id
            ? { ...f, path: result.path, mime: result.mime, size: result.size, sizeLabel: fmtBytes(result.size), uploading: false }
            : f),
        ),
      onFailed: message =>
        setPendingFiles(prev =>
          prev.map(f => f.id === id ? { ...f, uploading: false, error: message } : f),
        ),
    });
  }

  function handlePaste(e: ClipboardEvent): boolean {
    const items = Array.from(e.clipboardData?.items ?? []);
    const images = items.filter(it => it.kind === 'file' && it.type.startsWith('image/'));
    if (images.length > 0) {
      if (fixed) return false;
      if (catalog.input.length > 0 && !inputTypeAdvertised(catalog, 'localImage', configValues)) {
        return false;
      }
      e.preventDefault();
      const takenNames = new Set(pendingFiles.map(file => file.name));
      for (const it of images) {
        const file = it.getAsFile();
        if (!file || file.size > MAX_FILE_BYTES) continue;
        const name = dedupeAttachmentName(file.name || `paste-${Date.now()}.png`, takenNames);
        takenNames.add(name);
        void uploadOne(new File([file], name, { type: file.type }));
      }
      return true;
    }

    const pastedText = typeof e.clipboardData?.getData === 'function'
      ? e.clipboardData.getData('text/plain')
      : '';
    const lineCount = pastedText ? pastedText.split(/\r\n|\r|\n/).length : 0;
    if (
      !pastedText
      || (pastedText.length <= PASTED_TEXT_CARD_MIN_CHARS && lineCount <= PASTED_TEXT_CARD_MIN_LINES)
      || contextItems.length >= MAX_MESSAGE_CONTEXT_ITEMS
    ) return false;

    const byteSize = new Blob([pastedText]).size;
    if (byteSize > MAX_PASTED_TEXT_BYTES) {
      if (fixed || !canAttachLocalFile) return false;
      e.preventDefault();
      uploadOne(new File([pastedText], `pasted-text-${Date.now()}.txt`, { type: 'text/plain' }));
      return true;
    }
    e.preventDefault();
    const item: MessageContextItem = {
      type: 'pastedText',
      id: crypto.randomUUID(),
      text: pastedText,
      lineCount,
      byteSize,
    };
    setContextItems(previous => [...previous, item]);
    editorRef.current?.insertReference({
      id: item.id,
      referenceType: 'context',
      label: contextReferenceLabel(item),
    });
    requestAnimationFrame(() => editorRef.current?.focus());
    setContextError(null);
    return true;
  }

  function handleEditorKeyDown(e: KeyboardEvent): boolean {
    if (hardDisabled) {
      e.preventDefault();
      setSlashOpen(false);
      return true;
    }
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIdx(i => filtered.length > 0 ? Math.min(i + 1, filtered.length - 1) : 0);
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIdx(i => Math.max(i - 1, 0));
        return true;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (filtered[slashIdx]) pickCommand(filtered[slashIdx]);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashDismissedInput({ sessionId: session.id, text });
        setSlashOpen(false);
        return true;
      }
    }
    // ⌘/Ctrl+Enter: with a draft it steers the draft into the ACTIVE turn
    // (codex `turn/steer`) instead of queueing it; on other executors or when
    // idle it submits like plain Enter. With no draft it bubbles to the
    // document-level queue-drain handler.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (e.metaKey || e.ctrlKey)) {
      const hasDraft = text.trim().length > 0
        || pendingFiles.some(f => !f.uploading && !f.error && f.path)
        || contextItems.length > 0;
      if (!hasDraft) return false;
      e.preventDefault();
      if (onSteer && steerEnabled && disabled) steerSubmit();
      else submit();
      return true;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      submit();
      return true;
    }
    return false;
  }

  const activeContextReference = activeReference
    ? contextItems.find(item => item.id === activeReference.id) ?? null
    : null;
  const activeFileReference = activeReference
    ? pendingFiles.find(file => file.id === activeReference.id) ?? null
    : null;

  return (
    <div className={`composer-wrap${oneShotBypass ? ' is-bypass' : ''}`}>
      <div
        className="composer"
        style={{ position: 'relative' }}
      >
        {/* Hidden file input — triggered by the plus button */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileChange}
          aria-hidden="true"
          tabIndex={-1}
        />

        {oneShotBypass && (
          <div className="composer-bypass-banner" role="status">
            <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor"
                 strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 2L1 22h22z" />
              <path d="M12 9v6" />
              <path d="M12 18v.01" />
            </svg>
            <span>{t('composer.bypass.banner')}</span>
          </div>
        )}

        <div className="composer-input-wrap">
          <InlineComposerEditor
            ref={editorRef}
            initialDocument={initialDraft.document}
            disabled={hardDisabled}
            placeholder={disabled
              ? (busyPlaceholder ?? t('composer.placeholder.busy'))
              : (placeholder ?? t('composer.placeholder.idle'))}
            onChange={handleDocumentChange}
            onKeyDown={handleEditorKeyDown}
            onPaste={handlePaste}
            onReferenceActivate={(id, _referenceType, anchorEl) => setActiveReference(previous => previous?.id === id
              ? null
              : { id, anchor: anchorEl.getBoundingClientRect(), anchorEl })}
          />
        </div>

        {contextError && <div className="composer-context-error" role="status">{contextError}</div>}

        {activeReference && activeContextReference && (
          <ContextReferencePopover
            item={activeContextReference}
            anchor={activeReference.anchor}
            anchorEl={activeReference.anchorEl}
            onClose={() => setActiveReference(null)}
            onRemove={removeContextItem}
          />
        )}
        {activeReference && activeFileReference && (
          <ReferencePopover
            anchor={activeReference.anchor}
            anchorEl={activeReference.anchorEl}
            onClose={() => setActiveReference(null)}
          >
            <ReferencePopoverHead
              icon={REFERENCE_ICONS.file}
              title={activeFileReference.name}
              onRemove={() => removeFile(activeFileReference.id)}
              removeLabel={t('composer.attachment.remove')}
              onClose={() => setActiveReference(null)}
            />
            <div className="ref-pop-body">
              {isNativeImageMime(activeFileReference.mime) && (
                <img
                  className="ref-pop-thumb"
                  src={activeFileReference.previewUrl}
                  alt={activeFileReference.name}
                  onClick={() => zoomImage?.(activeFileReference.previewUrl, activeFileReference.name)}
                />
              )}
              <span className="ref-pop-meta">
                {activeFileReference.error ?? activeFileReference.sizeLabel}
              </span>
            </div>
          </ReferencePopover>
        )}

        {!fixed && !hardDisabled && slashOpen && slashPopPos && (slashLoading || filteredGroups.length > 0) && createPortal(
          <div
            ref={popRef}
            className="cmp-slash-pop"
            style={{ left: slashPopPos.left, bottom: slashPopPos.bottom, width: slashPopPos.width }}
          >
            {slashLoading && filtered.length === 0 && (
              <div className="cmp-slash-row" style={{ color: 'var(--text-3)', cursor: 'default' }}>
                <span className="cmp-slash-desc">{t('composer.slash.loading')}</span>
              </div>
            )}
            {filteredGroups.map(group => {
              let baseIdx = 0;
              for (const g of filteredGroups) {
                if (g.source === group.source) break;
                baseIdx += g.items.length;
              }
              return (
                <div key={group.source}>
                  <div className="cmp-slash-section">{t(`composer.slash.source.${group.source}`)}</div>
                  {group.items.map((item, localIdx) => {
                    const flatIdx = baseIdx + localIdx;
                    return (
                      <button
                        key={item.name}
                        type="button"
                        className={`cmp-slash-row${flatIdx === slashIdx ? ' active' : ''}`}
                        data-source={item.source}
                        title={item.filePath}
                        onPointerDown={e => { e.preventDefault(); pickCommand(item); }}
                        onMouseEnter={() => setSlashIdx(flatIdx)}
                      >
                        <span className="cmp-slash-cmd">{item.name}</span>
                        <span className="cmp-slash-desc">{item.description}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>,
          document.body,
        )}

          <div className="composer-bar">
            {!fixed && resolvedOverlay?.error && (
            <span className="composer-resolve-error" data-testid="composer-resolve-error">
              {resolvedOverlay.error}
            </span>
          )}
          {!fixed && <ContextUsageIndicator session={session} />}

          {fixed && modelControlVisible && !modelControlInteractive && (
            <span
              className="composer-opt cmp-static cmp-model-btn"
              data-testid="fixed-composer-model-chip"
              title={t('composer.model.section')}
            >
              <span className="name cmp-model">
                {modelLabel(displayModels, activeModel) || activeModel}
              </span>
            </span>
          )}

          {!fixed && showNativeFallback && nativeModelOption && (
            <NativeOptionDrop
              option={nativeModelOption}
              role="model"
              disabled={disabled || !onSetNativeConfig}
              onChange={value => setNativeConfigValue(nativeModelOption.id, value)}
            />
          )}

          {modelControlInteractive && showModelChip && (
            <>
              <button
                ref={modelDrop.btnRef}
                type="button"
                className={`composer-opt cmp-model-btn${modelDrop.open ? ' open' : ''}`}
                data-testid="composer-model-chip"
                title={t('composer.model.section')}
                disabled={disabled}
                onClick={() => modelDrop.setOpen(open => !open)}
              >
                <span className="name cmp-model">{modelLabel(displayModels, activeModel) || activeModel}</span>
              </button>
              {modelDrop.open && modelDrop.pos && createPortal(
                <div
                  ref={modelDrop.popRef}
                  className="popover model-pop"
                  role="dialog"
                  style={{ left: modelDrop.pos.left, bottom: modelDrop.pos.bottom }}
                >
                  <div className="mp-section-head">
                    <span className="mp-section-title">{t('composer.model.section')}</span>
                  </div>
                  <div className="mp-list">
                    {displayModels.filter(model => !model.hidden).map(model => {
                      const active = model.model === activeModel
                        || claudeModelFamily(activeModel) === model.model;
                      return (
                        <button
                          key={model.model}
                          type="button"
                          className={`mp-row${active ? ' active' : ''}`}
                          onClick={() => {
                            if (catalogModelOption) setCatalogOption(catalogModelOption, model.model);
                            else onSetModel(model.model);
                            modelDrop.setOpen(false);
                          }}
                        >
                          <span className="mp-check">{active ? '✓' : ''}</span>
                          <span className="mp-row-body">
                            <span className="mp-row-title">{model.displayName}</span>
                            {model.description && executor !== 'codex' && (
                              <span className="mp-row-hint">{model.description}</span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>,
                document.body,
              )}
            </>
          )}

          {modelControlVisible && effortControlVisible && <ControlSeparator />}

          {fixed && effortControlVisible && !effortControlInteractive && (
            <span
              className="composer-opt cmp-static cmp-think-btn"
              data-testid="fixed-composer-thinking-chip"
              title={t('composer.reasoning.effort')}
            >
              <span className="name">{effortLabel(executor, thinkLevel)}</span>
            </span>
          )}

          {!fixed && showNativeFallback && nativeEffortOption && (
            <NativeOptionDrop
              option={nativeEffortOption}
              role="effort"
              disabled={disabled || !onSetNativeConfig}
              onChange={value => setNativeConfigValue(nativeEffortOption.id, value)}
            />
          )}

          {effortControlInteractive && showEffortChip && (
            <>
              <button
                ref={thinkDrop.btnRef}
                type="button"
                className={`composer-opt cmp-think-btn${thinkDrop.open ? ' open' : ''}`}
                data-testid="composer-thinking-chip"
                title={t('composer.reasoning.effort')}
                disabled={disabled}
                onClick={() => thinkDrop.setOpen(open => !open)}
              >
                <span className="name">{effortLabel(executor, thinkLevel)}</span>
              </button>
              {thinkDrop.open && thinkDrop.pos && createPortal(
                <div
                  ref={thinkDrop.popRef}
                  className="popover think-pop"
                  role="dialog"
                  style={{ left: thinkDrop.pos.left, bottom: thinkDrop.pos.bottom }}
                >
                  <div className="mp-section-head">
                    <span className="mp-section-title">{t('composer.reasoning.effort')}</span>
                  </div>
                  <div className="mp-list">
                    {effortChoices.map(level => (
                      <button
                        key={level}
                        type="button"
                        className={`mp-row${thinkLevel === level ? ' active' : ''}`}
                        onClick={() => {
                          if (catalogEffortOption) setCatalogOption(catalogEffortOption, level);
                          else onSetEffort(level);
                          thinkDrop.setOpen(false);
                        }}
                      >
                        <span className="mp-check">{thinkLevel === level ? '✓' : ''}</span>
                        <span className="mp-row-body">
                          <span className="mp-row-title">{effortLabel(executor, level)}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>,
                document.body,
              )}
            </>
          )}

          {fastControlVisible && (modelControlVisible || effortControlVisible) && <ControlSeparator />}

          {fixed && fastControlVisible && !fastControlInteractive && (
            <span
              className={`composer-opt cmp-static cmp-fast${session.service_tier === 'fast' ? ' on' : ''}`}
              data-testid="fixed-composer-fast-chip"
              title={fastOption?.description ?? t('composer.fast.title')}
            >
              {fastOption?.displayName ?? t('composer.fast.button')}
            </span>
          )}

          {fastControlInteractive && showFast && onSetServiceTier && (
            <button
              type="button"
              className={`composer-opt cmp-fast${session.service_tier === 'fast' ? ' on' : ''}`}
              data-testid="composer-fast-chip"
              title={fastOption?.description ?? t('composer.fast.title')}
              aria-pressed={session.service_tier === 'fast'}
              disabled={disabled || !fastEnabled}
              onClick={() => {
                const checked = session.service_tier !== 'fast';
                if (fastOption) setCatalogOption(fastOption, checked);
                else onSetServiceTier(checked ? 'fast' : null);
              }}
            >
              {fastOption?.displayName ?? t('composer.fast.button')}
            </button>
          )}

          <span className="spacer" />

          {/* Permission mode leads the right-side cluster for Claude and Codex. */}
          {approvalControlInteractive && showApprovalChip && (
            <>
              <button
                ref={approvalDrop.btnRef}
                type="button"
                className={`composer-opt cmp-approval-btn${approvalDrop.open ? ' open' : ''}`}
                title={t('composer.approval.title')}
                disabled={disabled}
                onClick={() => approvalDrop.setOpen(o => !o)}
              >
                <span className="name">
                  {executor === 'claude' && oneShotBypass
                    ? t('composer.bypass.button')
                    : composerModeLabel(
                      executor,
                      approvalValue || 'ask',
                      catalogModeList ?? proxyModes,
                      t,
                    )}
                </span>
              </button>
              {approvalDrop.open && approvalDrop.pos && createPortal(
                <div
                  ref={approvalDrop.popRef}
                  className="popover approval-pop"
                  role="dialog"
                  style={{ left: approvalDrop.pos.left, bottom: approvalDrop.pos.bottom }}
                >
                  <div className="mp-section-head">
                    <span className="mp-section-title">
                      {executor === 'codex'
                        ? t('composer.approval.section')
                        : t('composer.mode.title')}
                    </span>
                  </div>
                  <div className="mp-list">
                    {modeOptions.map(opt => {
                      const active = !oneShotBypass && (
                        approvalValue === opt.mode || approvalValue === opt.key
                      );
                      const title = opt.titleKey ? t(opt.titleKey) : (opt.label ?? opt.key);
                      const hint = opt.descKey
                        ? t(opt.descKey)
                        : (!opt.titleKey && opt.description ? opt.description : null);
                      return (
                        <button
                          key={opt.key}
                          type="button"
                          className={`mp-row${active ? ' active' : ''}`}
                          onClick={() => {
                            setOneShotBypass(false);
                            setMode(opt.mode);
                            approvalDrop.setOpen(false);
                          }}
                        >
                          <span className="mp-check">{active ? '✓' : ''}</span>
                          <span className="mp-row-body">
                            <span className="mp-row-title">{title}</span>
                            {hint && (
                              <span className="mp-row-hint">{hint}</span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                    {!fixed && executor === 'claude' && (
                      <button
                        type="button"
                        className={`mp-row${oneShotBypass ? ' active' : ''}`}
                        onClick={() => {
                          setOneShotBypass(active => !active);
                          approvalDrop.setOpen(false);
                        }}
                      >
                        <span className="mp-check">{oneShotBypass ? '✓' : ''}</span>
                        <span className="mp-row-body">
                          <span className="mp-row-title">{t('composer.bypass.button')}</span>
                          <span className="mp-row-hint">{t('composer.bypass.title')}</span>
                        </span>
                      </button>
                    )}
                  </div>
                </div>,
                document.body
              )}
            </>
          )}

          {fixed && !approvalControlInteractive && (showApprovalChip || Boolean(approvalValue)) && (
            <span
              className="composer-opt cmp-static cmp-approval-btn"
              data-testid="fixed-composer-approval-chip"
              title={t('composer.approval.title')}
            >
              <span className="name">
                {composerModeLabel(
                  executor,
                  approvalValue || 'ask',
                  catalogModeList ?? proxyModes,
                  t,
                )}
              </span>
            </span>
          )}

          {!fixed && showNativeFallback && nativeModeOption && (
            <NativeOptionDrop
              option={nativeModeOption}
              role="mode"
              disabled={disabled || !onSetNativeConfig}
              onChange={value => setNativeConfigValue(nativeModeOption.id, value)}
            />
          )}

          {/* Attach files — plus glyph (VS Code style). Hidden in fixed
              (bare textarea variant, no attachment pipeline). */}
          {!fixed && (
            <>
              <button
                ref={addDrop.btnRef}
                type="button"
                className={`composer-act${addDrop.open ? ' active' : ''}`}
                disabled={hardDisabled || resourcePicking}
                title={t('composer.context.add')}
                onClick={() => addDrop.setOpen(open => !open)}
                aria-label={t('composer.context.add')}
              >
                {resourcePicking ? (
                  <span className="spinner" aria-hidden="true" />
                ) : (
                  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                )}
              </button>
              {addDrop.open && addDrop.pos && createPortal(
                <div
                  ref={addDrop.popRef}
                  className="popover composer-add-pop"
                  style={{ left: addDrop.pos.left, bottom: addDrop.pos.bottom }}
                >
                  <div className="mp-list">
                    <button
                      type="button"
                      className="mp-row"
                      onClick={() => {
                        if (resourcePickerAvailable) void pickComposerResources();
                        else {
                          addDrop.setOpen(false);
                          fileInputRef.current?.click();
                        }
                      }}
                    >
                      <span className="composer-add-icon" aria-hidden="true">
                        <svg viewBox="0 0 16 16" fill="none">
                          <path d="M5.25 8.75 9.8 4.2a2 2 0 0 1 2.8 2.8l-5.35 5.35a3 3 0 0 1-4.25-4.25l5-5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                      <span className="mp-row-body">
                        <span className="mp-row-title">
                          {resourcePickerAvailable
                            ? t('composer.context.filesAndFolders')
                            : t('composer.context.files')}
                        </span>
                        {!resourcePickerAvailable && (
                          <span className="mp-row-hint">{t('composer.context.foldersDesktopOnly')}</span>
                        )}
                      </span>
                    </button>
                  </div>
                </div>,
                document.body,
              )}
            </>
          )}

          {/* Send / Stop */}
          {running ? (
            <button
              type="button"
              className="composer-act primary danger"
              onClick={onStop}
              disabled={stopping}
              title={stopping ? t('composer.stopping') : t('composer.stop.title')}
              aria-label={stopping ? t('composer.stopping') : t('composer.stop.button')}
            >
              {stopping ? (
                <span className="spinner" aria-hidden="true" />
              ) : (
                <svg viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
                  <rect x="3" y="3" width="8" height="8" rx="1" />
                </svg>
              )}
            </button>
          ) : (
            <button
              type="button"
              className="composer-act primary"
              disabled={hardDisabled || (!text.trim() && !canSendAttachmentOnly && !canSendContextOnly)}
              onClick={submit}
              title={t('composer.send.button')}
              aria-label={t('composer.send.button')}
            >
              <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2.5 7l9-4.5-3 9-2-3.5-4-1.5z" fill="currentColor" stroke="currentColor" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {footer}
    </div>
  );
}
