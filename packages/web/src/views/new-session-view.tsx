import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  ApprovalMode,
  ComposerDocument,
  ComposerReferenceSegment,
  ConfigOption,
  ConfigValue,
  Executor,
  MessageContextItem,
  PickComposerResourcesResult,
  ProxyModeCapabilities,
  ThinkingEffort,
  UserAgentStatus,
  Workspace,
} from '@gian/shared';
import {
  MAX_MESSAGE_CONTEXT_ITEMS,
  MAX_PASTED_TEXT_BYTES,
  composerDocumentUserText,
  normalizeBrowserElementCapture,
  normalizeComposerDocument,
  usesNativeExecutorConfig,
} from '@gian/shared';
import { loadAgents, loadResolvedProxyCatalog, peekAgents } from '../api.js';
import { MAX_FILE_BYTES, dedupeAttachmentName, fmtBytes, isNativeImageMime } from '../attachments.js';
import { desktopBridge } from '../desktop-bridge.js';
import { useT } from '../i18n/index.js';
import {
  applyResolvedDefaults,
  claudeModelFamily,
  composerModeLabel,
  composerModeOptions,
  createConfigsFromCatalog,
  defaultEffort,
  defaultModel,
  effortLabel,
  fetchCatalogCached,
  fetchModelsCached,
  fetchModesCached,
  getCatalogCached,
  getModelsCached,
  getModesCached,
  inputTypeAdvertised,
  modelLabel,
  modelsFromCatalog,
  displayModelsFromCatalog,
  optionByRole,
  optionEnabled,
  optionVisible,
  supportedEfforts,
} from '../components/composer/capabilities.js';
import type { ComposerCatalog } from '../components/composer/capabilities.js';
import type { ProxyModel } from '../components/composer/capabilities.js';
import { AgentLogo } from '../components/AgentLogo.js';
import { useUpDrop } from '../components/composer/option-drops.js';
import {
  ContextReferencePopover,
  REFERENCE_ICONS,
  ReferencePopover,
  ReferencePopoverHead,
} from '../components/composer/reference-popover.js';
import type { ReferenceAnchor } from '../components/composer/reference-popover.js';
import {
  InlineComposerEditor,
  type InlineComposerEditorHandle,
} from '../components/composer/InlineComposerEditor.js';
import {
  useOperationDispatchOptional,
  useOperationStoreOptional,
  waitForRunSettle,
} from '../operations/use-operations.js';
import '../operations/context.js';
import {
  clearNewSessionDraftStorage,
  loadNewSessionScreenshotBlob,
  NEW_SESSION_SCREENSHOT_EVENT,
  newSessionDraftStorageKey,
  removeNewSessionScreenshot,
  screenshotEventMatchesScope,
  storeNewSessionAttachment,
  type NewSessionScreenshotDraftAttachment,
} from '../screenshot-drafts.js';
import { publishScreenshotTarget } from '../screenshot-target.js';
import { ImageZoomContext } from '../transcript/items.js';

export { newSessionDraftStorageKey } from '../screenshot-drafts.js';

export interface NewSessionFirstAttachment extends NewSessionScreenshotDraftAttachment {
  blob: Blob;
}

export interface CreateSessionInput {
  workspaceId: string;
  name: string;
  /** Owning saved Agent — the Host resolves kind/path/defaults from it. */
  agentId?: string;
  executor: Executor;
  /** First user message — sent automatically once the session exists. The
   *  create payload itself stays free of it (ses-001 contract); App hands it
   *  to the `session:created` socket handler via pendingFirstMessageRef. */
  firstMessage: string;
  composerDocument?: ComposerDocument;
  /** Screenshots captured before the Session exists. They are uploaded into
   *  the newly-created Session before its first structured message is sent. */
  firstAttachments?: NewSessionFirstAttachment[];
  contextItems?: MessageContextItem[];
  /** Capability chips the user picked on the new-session composer; omitted
   *  fields fall back to the host's configured defaults. Kimi never carries
   *  approvalMode (executor-native configuration); serviceTier is Codex-only. */
  model?: string;
  thinkingEffort?: ThinkingEffort | null;
  approvalMode?: ApprovalMode | null;
  /** Codex-only Fast service tier. Omitted/null keeps the standard tier. */
  serviceTier?: 'fast' | null;
  sessionConfig?: Record<string, ConfigValue>;
  turnConfig?: Record<string, ConfigValue>;
}

export interface SessionCreateFormState {
  workspaceId: string;
  sessionName: string;
  agentId?: string;
  executor: Executor;
  model?: string;
  thinkingEffort?: ThinkingEffort | null;
  approvalMode?: ApprovalMode | null;
  serviceTier?: 'fast' | null;
  catalogOptions?: ConfigOption[];
  catalogValues?: Record<string, ConfigValue>;
}

export function buildSessionCreatePayload(
  form: SessionCreateFormState,
): Omit<CreateSessionInput, 'firstMessage'> {
  const catalog = form.catalogOptions && form.catalogOptions.length > 0
    ? createConfigsFromCatalog(form.executor, form.catalogOptions, form.catalogValues ?? {})
    : null;
  return {
    workspaceId: form.workspaceId,
    name: form.sessionName.trim(),
    ...(form.agentId ? { agentId: form.agentId } : {}),
    executor: form.executor,
    ...((catalog?.model ?? form.model) ? { model: catalog?.model ?? form.model } : {}),
    ...(!usesNativeExecutorConfig(form.executor) && (catalog?.approvalMode ?? form.approvalMode)
      ? { approvalMode: catalog?.approvalMode ?? form.approvalMode }
      : {}),
    ...((catalog ? catalog.thinkingEffort : form.thinkingEffort)
      ? { thinkingEffort: catalog ? catalog.thinkingEffort : form.thinkingEffort }
      : {}),
    ...(form.executor === 'codex' && (catalog?.serviceTier ?? form.serviceTier) === 'fast'
      ? { serviceTier: 'fast' as const }
      : {}),
    ...(catalog && Object.keys(catalog.session_config).length > 0
      ? { sessionConfig: catalog.session_config }
      : {}),
    ...(catalog && Object.keys(catalog.turn_config).length > 0
      ? { turnConfig: catalog.turn_config }
      : {}),
  };
}

/** Last-used new-session choices, remembered across opens (localStorage). */
const LAST_KEY = 'gian.new-session.last.v1';
/** Legacy one-shot draft key used before drafts were isolated per Task /
 *  Workspace. It is read once as a migration path for an already-open New
 *  Workspace round trip, but all new writes use DRAFT_KEY_PREFIX. */
const LEGACY_DRAFT_KEY = 'gian.new-session.draft.v1';
/** Persistent unsent drafts. A Workspace and a Task never share composer
 *  state; switching away only hides the form, while confirmed creation is
 *  the boundary that clears its owner draft. */
/** Most recently foregrounded Workspace draft. The header "+" has no
 *  explicit Workspace, so this pointer lets it reopen the draft the user
 *  actually left instead of falling back to the last successfully-created
 *  Session's Workspace. */
const ACTIVE_WORKSPACE_DRAFT_KEY = 'gian.new-session.draft.active-workspace.v1';
/** Set while the New Workspace sheet is open via the new-session page — App
 *  returns to a fresh new-session page (with the created workspace
 *  preselected) when the sheet reports a successful create. */
const RETURN_KEY = 'gian.new-session.return.v1';
const PASTED_TEXT_CARD_MIN_CHARS = 800;
const PASTED_TEXT_CARD_MIN_LINES = 8;

interface StoredNewSession {
  workspaceId?: string;
  agentId?: string;
  executor?: Executor;
  model?: string;
  thinkingEffort?: ThinkingEffort | null;
  approvalMode?: ApprovalMode | null;
  serviceTier?: 'fast' | null;
}

interface NewSessionDraft extends StoredNewSession {
  sessionName?: string;
  message?: string;
  document?: ComposerDocument;
  screenshotAttachments?: NewSessionScreenshotDraftAttachment[];
  contextItems?: MessageContextItem[];
}

const EMPTY_COMPOSER_DOCUMENT: ComposerDocument = { version: 1, segments: [] };

function newSessionContextLabel(item: MessageContextItem): string {
  if (item.type === 'folder') return item.name;
  if (item.type === 'browserElement') return item.name || item.selector;
  const preview = item.text.replace(/\s+/g, ' ').trim();
  return preview.slice(0, 80) || 'Pasted text';
}

function newSessionReferenceIds(document: ComposerDocument): Set<string> {
  return new Set(document.segments.flatMap(segment => (
    segment.type === 'reference' ? [segment.id] : []
  )));
}

function newSessionComposerDocument(draft: NewSessionDraft | null): ComposerDocument {
  const normalized = normalizeComposerDocument(draft?.document);
  if (normalized) return normalized;
  const attachments = draft?.screenshotAttachments ?? [];
  const contextItems = savedContextItems(draft?.contextItems);
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
      label: newSessionContextLabel(item),
    })),
  ];
  const text = draft?.message ?? '';
  const segments: ComposerDocument['segments'] = [];
  references.forEach((reference, index) => {
    segments.push(reference);
    if (index < references.length - 1 || text) segments.push({ type: 'text', text: '\n' });
  });
  if (text) segments.push({ type: 'text', text });
  return normalizeComposerDocument({ version: 1, segments }) ?? EMPTY_COMPOSER_DOCUMENT;
}

function savedContextItems(value: unknown): MessageContextItem[] {
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

export interface NewSessionDraftScope {
  kind: 'workspace' | 'task';
  id: string;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as T;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage unavailable — remembering defaults is best-effort.
  }
}

function readNewSessionDraft(scope: NewSessionDraftScope | null): NewSessionDraft | null {
  return scope ? readJson<NewSessionDraft>(newSessionDraftStorageKey(scope)) : null;
}

export function clearNewSessionDraft(scope: NewSessionDraftScope): void {
  clearNewSessionDraftStorage(scope);
}

/** Consume a v1 draft left by an older New Workspace round trip. */
function takeLegacyNewSessionDraft(): NewSessionDraft | null {
  const draft = readJson<NewSessionDraft>(LEGACY_DRAFT_KEY);
  if (draft) {
    try { localStorage.removeItem(LEGACY_DRAFT_KEY); } catch { /* best-effort */ }
  }
  return draft;
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor"
         strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function ControlSeparator() {
  return <span className="cmp-control-sep" aria-hidden="true">|</span>;
}

export function NewSessionView({
  workspaces,
  initialWorkspaceId,
  initialAgentId,
  draftScope,
  draftLabel,
  onCreate,
  onCancel,
  onNewWorkspace,
  creating,
  createError,
  createUnknown = false,
  verifyingCreate = false,
  onVerifyCreate,
}: {
  workspaces: Workspace[];
  /** Preselected workspace (sidebar workspace-row "+" entry point, or the
   *  auto-return from the New Workspace sheet). */
  initialWorkspaceId?: string;
  /** Preselected Agent (⌘J/⌘K "new subtask" shortcut carries the choice). */
  initialAgentId?: string;
  /** Task-owned forms keep one persistent draft per Task. Session-mode forms
   *  omit this prop and are automatically keyed by the selected Workspace. */
  draftScope?: NewSessionDraftScope;
  /** Human-readable locked target shown by the Desktop capture overlay. */
  draftLabel?: string;
  onCreate: (input: CreateSessionInput) => void;
  onCancel: () => void;
  /** Open the Workspaces "New workspace" sheet tab (the drop's "+ New
   *  workspace" row). The view stashes its draft first; App returns here
   *  with the created workspace preselected. */
  onNewWorkspace: () => void;
  creating: boolean;
  createError?: string | null;
  createUnknown?: boolean;
  verifyingCreate?: boolean;
  onVerifyCreate?: () => void;
}) {
  const t = useT();
  // Thumbnail click opens the app-level ImageLightbox (App.tsx provides this
  // context), same as the session Composer's pending-attachment chips.
  const zoomImage = useContext(ImageZoomContext);
  const operationDispatch = useOperationDispatchOptional();
  const operationStore = useOperationStoreOptional();
  const [last] = useState(() => readJson<StoredNewSession>(LAST_KEY));
  const [initial] = useState(() => {
    const usable = (id: string | undefined) =>
      id !== undefined && workspaces.some(w => w.id === id && w.hidden !== 1);
    let activeDraftWorkspaceId: string | undefined;
    if (draftScope?.kind !== 'task') {
      try { activeDraftWorkspaceId = localStorage.getItem(ACTIVE_WORKSPACE_DRAFT_KEY) ?? undefined; }
      catch { /* best-effort */ }
    }
    let workspaceId = '';
    if (usable(initialWorkspaceId)) workspaceId = initialWorkspaceId!;
    else if (usable(activeDraftWorkspaceId)) workspaceId = activeDraftWorkspaceId!;
    else if (usable(last?.workspaceId)) workspaceId = last!.workspaceId!;
    else workspaceId = workspaces.find(w => w.hidden !== 1 && w.name !== '__gian_root__')?.id ?? '';
    const owner = draftScope?.kind === 'task'
      ? draftScope
      : workspaceId ? { kind: 'workspace' as const, id: workspaceId } : null;
    const saved = readNewSessionDraft(owner) ?? takeLegacyNewSessionDraft();
    // A Task draft owns its Workspace choice too. A Workspace draft cannot
    // redirect the form to another Workspace because the storage key itself
    // is the ownership boundary.
    if (draftScope?.kind === 'task' && usable(saved?.workspaceId)) {
      workspaceId = saved!.workspaceId!;
    }
    return { draft: saved, workspaceId, composerDocument: newSessionComposerDocument(saved) };
  });
  const [draft, setDraft] = useState<NewSessionDraft | null>(initial.draft);
  const [selectedWs, setSelectedWs] = useState(initial.workspaceId);
  const [sessionName, setSessionName] = useState(draft?.sessionName ?? '');
  const [composerDocument, setComposerDocument] = useState(initial.composerDocument);
  const [message, setMessage] = useState(() => composerDocumentUserText(initial.composerDocument));
  const [contextItems, setContextItems] = useState<MessageContextItem[]>(
    () => savedContextItems(draft?.contextItems),
  );
  const [screenshotAttachments, setScreenshotAttachments] = useState<
    NewSessionScreenshotDraftAttachment[]
  >(() => draft?.screenshotAttachments ?? []);
  const [screenshotPreviews, setScreenshotPreviews] = useState<Record<string, string>>({});
  const [preparingAttachments, setPreparingAttachments] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  /** Which agents exist and whether they're usable — driven by the host's
   *  /api/agents install status so the picker follows Settings, not a
   *  hardcoded list. Null while loading. */
  const [agents, setAgents] = useState<UserAgentStatus[] | null>(() => peekAgents());
  const requestedAgentId = initialAgentId ?? draft?.agentId ?? null;
  const [agentId, setAgentId] = useState<string | null>(requestedAgentId);
  const selectedAgent = agents?.find(agent => agent.id === agentId) ?? null;
  const executor = selectedAgent?.proxy ?? null;
  // Capability chip state holds only explicit per-draft choices. Catalog-backed
  // native executors use the same state now that their options are available
  // before session.create; configured Agent defaults remain display fallbacks.
  const [model, setModel] = useState(draft?.model ?? '');
  const [effort, setEffort] = useState<ThinkingEffort | null>(draft?.thinkingEffort ?? null);
  const [mode, setMode] = useState<ApprovalMode | null>(draft?.approvalMode ?? null);
  const [serviceTier, setServiceTier] = useState<'fast' | null>(draft?.serviceTier ?? null);
  const [initialCatalog] = useState(() => (
    executor ? getCatalogCached(executor, agentId) : undefined
  ));
  const [catalog, setCatalog] = useState<ComposerCatalog>(() => (
    initialCatalog ?? { configOptions: [], input: [], slashCommands: [] }
  ));
  const [catalogExecutor, setCatalogExecutor] = useState<Executor | null>(
    initialCatalog && executor ? executor : null,
  );
  const [catalogValues, setCatalogValues] = useState<Record<string, ConfigValue>>({});
  const [catalogResolveError, setCatalogResolveError] = useState<string | null>(null);
  const [models, setModels] = useState<ProxyModel[]>([]);
  const [proxyModes, setProxyModes] = useState<ProxyModeCapabilities[]>([]);
  const [wsQuery, setWsQuery] = useState('');
  const agentDrop = useUpDrop(280);
  const wsDrop = useUpDrop(320);
  const modelDrop = useUpDrop(320);
  const thinkDrop = useUpDrop(210);
  const modeDrop = useUpDrop(340, { align: 'right' });
  const addDrop = useUpDrop(220, { align: 'right' });
  const [resourcePicking, setResourcePicking] = useState(false);
  const [activeReference, setActiveReference] = useState<{
    id: string;
    anchor: ReferenceAnchor;
    anchorEl: HTMLElement;
  } | null>(null);
  const editorRef = useRef<InlineComposerEditorHandle>(null);
  const attachmentIdsRef = useRef(new Set(initial.draft?.screenshotAttachments?.map(item => item.id) ?? []));
  const catalogResolveSignature = useRef('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const screenshotAvailable = !!desktopBridge()?.screenshot;
  const resourcePickerAvailable = !!desktopBridge()?.resources;

  useEffect(() => {
    let cancelled = false;
    loadAgents()
      .then(list => { if (!cancelled) setAgents(list); })
      .catch(() => { if (!cancelled) setAgents([]); });
    return () => { cancelled = true; };
  }, []);

  // Agent default: explicit preselect (⌘J/⌘K) > restored draft > last-used
  // Agent (still ready) > legacy last-used kind's first ready Agent > the
  // single ready agent (auto-selected, picker static). With several ready
  // agents and no memory, nothing is selected and Send stays disabled.
  useEffect(() => {
    if (!agents || agentId) return;
    const ready = agents.filter(agent => agent.ready);
    const rememberedId = draft?.agentId ?? last?.agentId;
    if (rememberedId && ready.some(agent => agent.id === rememberedId)) {
      setAgentId(rememberedId);
      return;
    }
    const rememberedKind = draft?.executor ?? last?.executor;
    if (rememberedKind) {
      const ofKind = ready.find(agent => agent.proxy === rememberedKind);
      if (ofKind) {
        setAgentId(ofKind.id);
        return;
      }
    }
    if (ready.length === 1) setAgentId(ready[0]!.id);
  }, [agents, agentId, draft, last]);

  // Chip state holds ONLY explicit choices (restored draft / last-used values
  // for this agent, or rows the user picks from a drop). Display falls back
  // to the Settings-managed proxy defaults, then the capability list's own
  // defaults; the create payload carries only explicit choices so the host's
  // configured defaults stay authoritative otherwise. Models/modes load
  // lazily per executor (cached).
  useEffect(() => {
    if (!executor) {
      setModels([]);
      setProxyModes([]);
      setModel('');
      setEffort(null);
      setMode(null);
      setServiceTier(null);
      return;
    }
    const remembered = draft?.executor === executor
      ? draft
      : (last?.executor === executor ? last : null);
    setModel(remembered?.model ?? '');
    setEffort(remembered?.thinkingEffort ?? null);
    setMode(remembered?.approvalMode ?? null);
    if (usesNativeExecutorConfig(executor)) {
      setModels([]);
      setProxyModes([]);
      setServiceTier(null);
      return;
    }
    const cli = executor;
    setModels(getModelsCached(cli, agentId) ?? []);
    setProxyModes(getModesCached(cli, agentId) ?? []);
    setServiceTier(cli === 'codex' ? (remembered?.serviceTier ?? null) : null);

    let alive = true;
    void fetchModelsCached(cli, agentId)
      .then(list => { if (alive) setModels(list); })
      .catch(() => { /* chips keep the built-in fallbacks */ });
    void fetchModesCached(cli, agentId)
      .then(list => { if (alive) setProxyModes(list); })
      .catch(() => { /* built-in mode lists */ });
    return () => { alive = false; };
  }, [executor, agentId, draft, last]);

  useEffect(() => {
    // Config IDs are Proxy-owned. Never carry values across executors even
    // when two catalogs happen to reuse an ID such as `model` or `effort`.
    setCatalogValues({});
    catalogResolveSignature.current = '';
    if (!executor) {
      setCatalog({ configOptions: [], input: [], slashCommands: [] });
      setCatalogExecutor(null);
      return;
    }
    const cached = getCatalogCached(executor, agentId);
    if (cached) {
      setCatalog(cached);
      setCatalogExecutor(executor);
      const fromCatalog = modelsFromCatalog(optionByRole(cached.configOptions, 'model'));
      if (fromCatalog.length > 0) setModels(fromCatalog);
      return;
    }
    setCatalogExecutor(null);
    let alive = true;
    void fetchCatalogCached(executor, agentId)
      .then(next => {
        if (!alive) return;
        setCatalog(next);
        setCatalogExecutor(executor);
        const fromCatalog = modelsFromCatalog(optionByRole(next.configOptions, 'model'));
        if (fromCatalog.length > 0) setModels(fromCatalog);
      })
      .catch(() => {
        if (alive) {
          setCatalog({ configOptions: [], input: [], slashCommands: [] });
          setCatalogExecutor(executor);
        }
      });
    return () => { alive = false; };
  }, [executor, agentId]);

  useEffect(() => {
    if (
      !executor
      || catalogExecutor !== executor
      || !catalog.resolveAdvertised
      || !catalog.catalogRevision
    ) {
      catalogResolveSignature.current = '';
      setCatalogResolveError(null);
      return;
    }
    const values: Record<string, ConfigValue> = { ...catalogValues };
    for (const option of catalog.configOptions) {
      if (option.role === 'model' && model) values[option.id] = model;
      else if (
        option.role === 'effort'
        && effort
        && option.choices?.some(choice => Object.is(choice.value, effort))
      ) values[option.id] = effort;
      else if (option.role === 'approval_mode' && mode) values[option.id] = mode;
      else if (option.role === 'fast') values[option.id] = serviceTier === 'fast';
    }
    const configs = createConfigsFromCatalog(executor, catalog.configOptions, values);
    const signature = JSON.stringify({
      executor,
      revision: catalog.catalogRevision,
      sessionConfig: configs.session_config,
      turnConfig: configs.turn_config,
    });
    if (!catalogResolveSignature.current) {
      catalogResolveSignature.current = signature;
      return;
    }
    if (catalogResolveSignature.current === signature) return;
    catalogResolveSignature.current = signature;
    let alive = true;
    void loadResolvedProxyCatalog(executor, {
      catalogRevision: catalog.catalogRevision,
      sessionConfig: configs.session_config,
      turnConfig: configs.turn_config,
    }, agentId).then((resolved) => {
      if (!alive) return;
      setCatalog({
        catalogRevision: resolved.catalogRevision,
        configOptions: resolved.configOptions,
        input: resolved.input,
        slashCommands: resolved.slashCommands,
        resolveAdvertised: true,
      });
      const fromCatalog = modelsFromCatalog(optionByRole(resolved.configOptions, 'model'));
      if (fromCatalog.length > 0) setModels(fromCatalog);
      setCatalogValues(current => applyResolvedDefaults(current, {
        ...resolved.resolvedDefaults.sessionConfig,
        ...resolved.resolvedDefaults.turnConfig,
      }));
      setCatalogResolveError(null);
    }).catch((error: unknown) => {
      if (!alive) return;
      setCatalogResolveError(error instanceof Error ? error.message : String(error));
    });
    return () => { alive = false; };
  }, [executor, catalogExecutor, catalog, catalogValues, model, effort, mode, serviceTier]);

  function currentDraft(workspaceId = selectedWs): NewSessionDraft {
    const referenceIds = newSessionReferenceIds(composerDocument);
    return {
      workspaceId,
      sessionName,
      message,
      document: composerDocument,
      ...(contextItems.some(item => referenceIds.has(item.id))
        ? { contextItems: contextItems.filter(item => referenceIds.has(item.id)) }
        : {}),
      ...(screenshotAttachments.some(item => referenceIds.has(item.id))
        ? { screenshotAttachments: screenshotAttachments.filter(item => referenceIds.has(item.id)) }
        : {}),
      ...(agentId ? { agentId } : {}),
      ...(executor ? { executor } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { thinkingEffort: effort } : {}),
      ...(mode ? { approvalMode: mode } : {}),
      ...(executor === 'codex' && serviceTier ? { serviceTier } : {}),
    };
  }

  function activeDraftScope(workspaceId = selectedWs): NewSessionDraftScope | null {
    if (draftScope?.kind === 'task') return draftScope;
    return workspaceId ? { kind: 'workspace', id: workspaceId } : null;
  }

  // Persist continuously, not only during the New Workspace detour. A normal
  // sidebar navigation unmounts this form, so every committed edit must
  // already be recoverable when the user comes back.
  useEffect(() => {
    const owner = activeDraftScope();
    if (owner) {
      writeJson(newSessionDraftStorageKey(owner), currentDraft());
      if (owner.kind === 'workspace') {
        try { localStorage.setItem(ACTIVE_WORKSPACE_DRAFT_KEY, owner.id); } catch { /* best-effort */ }
      }
    }
  }, [
    selectedWs,
    sessionName,
    message,
    composerDocument,
    contextItems,
    agentId,
    executor,
    model,
    effort,
    mode,
    serviceTier,
    screenshotAttachments,
    draftScope?.kind,
    draftScope?.id,
  ]);

  const currentScope = activeDraftScope();
  const currentScopeKey = currentScope ? `${currentScope.kind}:${currentScope.id}` : '';
  const selectedWorkspace = workspaces.find(w => w.id === selectedWs) ?? null;

  // The Desktop result is routed by its capture-time scope. A view that has
  // since switched Workspace ignores the event; that attachment remains in
  // the old Workspace's durable draft and appears when the user returns.
  useEffect(() => {
    if (!currentScope) return;
    const onScreenshot = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!screenshotEventMatchesScope(detail, currentScope)) return;
      const additions = detail.attachments.filter(item => !attachmentIdsRef.current.has(item.id));
      attachmentIdsRef.current = new Set(detail.attachments.map(item => item.id));
      setScreenshotAttachments(detail.attachments);
      setAttachmentError(null);
      for (const attachment of additions) {
        editorRef.current?.insertReference({
          id: attachment.id,
          referenceType: 'attachment',
          label: attachment.name,
        });
      }
      requestAnimationFrame(() => editorRef.current?.focus());
    };
    window.addEventListener(NEW_SESSION_SCREENSHOT_EVENT, onScreenshot);
    return () => window.removeEventListener(NEW_SESSION_SCREENSHOT_EVENT, onScreenshot);
  }, [currentScopeKey]);

  useEffect(() => {
    if (!currentScope) {
      setScreenshotPreviews({});
      return;
    }
    let alive = true;
    const urls: string[] = [];
    void Promise.all(screenshotAttachments.map(async attachment => {
      if (!isNativeImageMime(attachment.mime)) return null;
      const blob = await loadNewSessionScreenshotBlob(currentScope, attachment.id);
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      urls.push(url);
      return [attachment.id, url] as const;
    })).then(entries => {
      if (!alive) return;
      setScreenshotPreviews(Object.fromEntries(entries.filter(
        (entry): entry is readonly [string, string] => entry !== null,
      )));
    });
    return () => {
      alive = false;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [currentScopeKey, screenshotAttachments]);

  useEffect(() => {
    if (!currentScope || !screenshotAvailable) return;
    const label = draftScope?.kind === 'task'
      ? (draftLabel?.trim() || t('tasks.detail.empty'))
      : (selectedWorkspace?.name || t('coding.new.title'));
    return publishScreenshotTarget({ kind: 'new-session', scope: currentScope, label });
  }, [currentScopeKey, draftLabel, draftScope?.kind, screenshotAvailable, selectedWorkspace?.name, t]);

  const readyAgents = (agents ?? []).filter(agent => agent.ready);
  // Exactly one usable agent: no choice to make — the chip shows it
  // statically (issue #57). Zero or 2+ ready agents get the picker drop
  // (not-ready rows render disabled).
  const showAgentPicker = readyAgents.length !== 1;
  const cliExecutor = executor && usesNativeExecutorConfig(executor) ? null : executor;
  const configuredDefaults = selectedAgent?.defaults;
  const catalogReady = catalog.configOptions.length > 0;
  const catalogModel = optionByRole(catalog.configOptions, 'model');
  const catalogEffort = optionByRole(catalog.configOptions, 'effort');
  const catalogApproval = optionByRole(catalog.configOptions, 'approval_mode');
  const catalogFast = optionByRole(catalog.configOptions, 'fast');
  const displayModels = displayModelsFromCatalog(catalogModel, undefined, models);
  // Display fallbacks: explicit chip state > Settings proxy defaults >
  // capability-list defaults.
  const displayModel = model
    || configuredDefaults?.model.trim()
    || (cliExecutor ? defaultModel(displayModels, cliExecutor) : '')
    || (catalogModel?.defaultValue != null ? String(catalogModel.defaultValue) : '')
    || (displayModels.find(candidate => candidate.isDefault)?.model ?? displayModels[0]?.model ?? '');
  const currentModelMeta = displayModels.find(m => m.model === displayModel)
    ?? displayModels.find(m => m.isDefault)
    ?? displayModels[0];
  const catalogEffortChoices = new Set(
    (catalogEffort?.choices ?? []).map(choice => String(choice.value)),
  );
  const explicitEffort = effort
    && (catalogEffortChoices.size === 0 || catalogEffortChoices.has(effort))
    ? effort
    : null;
  const configuredEffort = (configuredDefaults?.thinking.trim() || null) as ThinkingEffort | null;
  const validConfiguredEffort = configuredEffort
    && (catalogEffortChoices.size === 0 || catalogEffortChoices.has(configuredEffort))
    ? configuredEffort
    : null;
  const displayEffort = explicitEffort
    ?? validConfiguredEffort
    ?? (catalogEffort?.defaultValue != null
      ? String(catalogEffort.defaultValue) as ThinkingEffort
      : null)
    ?? defaultEffort(currentModelMeta);
  const catalogDefaultMode = typeof catalogApproval?.defaultValue === 'string'
    && catalogApproval.defaultValue
    ? catalogApproval.defaultValue as ApprovalMode
    : null;
  const displayMode = mode
    ?? ((configuredDefaults?.mode.trim() || null) as ApprovalMode | null)
    ?? catalogDefaultMode
    ?? 'ask';
  const nativeDefaults = executor && usesNativeExecutorConfig(executor)
    ? configuredDefaults
    : undefined;
  const catalogModes: ProxyModeCapabilities[] = catalogApproval?.choices?.map((choice) => ({
    id: String(choice.value),
    label: choice.displayName,
    description: choice.description ?? '',
    isDefault: Object.is(choice.value, catalogApproval.defaultValue),
  })) ?? [];
  const advertisedModes = catalogModes.length > 0 ? catalogModes : proxyModes;
  const modeOptions = composerModeOptions(executor ?? 'claude', advertisedModes);
  const turnModel = catalogModel?.binding === 'turn' ? catalogModel : undefined;
  const turnEffort = catalogEffort?.binding === 'turn' ? catalogEffort : undefined;
  const turnFast = catalogFast?.binding === 'turn' ? catalogFast : undefined;
  const showModelChip = Boolean(cliExecutor || (catalogReady && turnModel));
  const showEffortChip = Boolean(cliExecutor || (catalogReady && turnEffort));
  const showApprovalChip = Boolean(cliExecutor || (catalogReady && catalogApproval));
  const showNativeStatic = Boolean(executor && usesNativeExecutorConfig(executor) && !catalogReady);
  const modelControlVisible = showModelChip || showNativeStatic;
  const effortControlVisible = showEffortChip || showNativeStatic;
  const catalogViewValues: Record<string, ConfigValue> = { ...catalogValues };
  if (catalogModel && displayModel) catalogViewValues[catalogModel.id] = displayModel;
  if (catalogEffort && displayEffort) catalogViewValues[catalogEffort.id] = displayEffort;
  if (catalogApproval && displayMode) catalogViewValues[catalogApproval.id] = displayMode;
  if (catalogFast) catalogViewValues[catalogFast.id] = serviceTier === 'fast';
  const showFastChip = turnFast
    ? optionVisible(turnFast, catalogViewValues)
    : !catalogReady && executor === 'codex';
  const fastEnabled = !turnFast || optionEnabled(turnFast, catalogViewValues);
  const specialOptionIds = new Set(
    [catalogModel, catalogEffort, catalogFast, catalogApproval]
      .filter((option): option is ConfigOption => Boolean(option))
      .map((option) => option.id),
  );
  const sessionExtras = catalog.configOptions.filter((option) => (
    option.binding === 'session'
    && specialOptionIds.has(option.id)
    && option.id !== catalogApproval?.id
    && optionVisible(option, catalogViewValues)
  ));
  const canAttachLocalFile = catalog.input.length === 0
    || inputTypeAdvertised(catalog, 'localFile', catalogValues);

  const wsRows = workspaces.filter(w => w.name !== '__gian_root__');
  const query = wsQuery.trim().toLowerCase();
  const filteredWs = query
    ? wsRows.filter(w => w.name.toLowerCase().includes(query))
    : wsRows;

  function pickModel(next: string) {
    setModel(next);
    const meta = displayModels.find(m => m.model === next);
    const efforts = supportedEfforts(meta);
    // Keep an explicit effort only when the new model supports it.
    if (effort && efforts.length > 0 && !efforts.includes(effort)) {
      setEffort(defaultEffort(meta));
    }
    if (turnFast && serviceTier === 'fast') {
      const nextValues = {
        ...catalogViewValues,
        ...(catalogModel ? { [catalogModel.id]: next } : {}),
      };
      if (!optionVisible(turnFast, nextValues) || !optionEnabled(turnFast, nextValues)) {
        setServiceTier(null);
      }
    }
  }

  function pickWorkspace(nextWorkspaceId: string) {
    if (nextWorkspaceId === selectedWs) {
      wsDrop.setOpen(false);
      return;
    }

    if (draftScope?.kind === 'task') {
      // The Task is the owner; Workspace is simply one field inside that
      // Task's draft.
      setSelectedWs(nextWorkspaceId);
    } else {
      // Workspace-mode drafts switch owners. Snapshot the source before
      // loading the target so neither side can overwrite the other.
      const currentOwner = activeDraftScope();
      if (currentOwner) {
        writeJson(newSessionDraftStorageKey(currentOwner), currentDraft());
      }
      const nextOwner = { kind: 'workspace' as const, id: nextWorkspaceId };
      const savedNextDraft = readNewSessionDraft(nextOwner);
      // A never-opened Workspace starts with a blank goal/title but keeps the
      // current Agent/capability choices as convenient defaults. Once that
      // Workspace has its own draft, its complete choices win instead.
      const nextDraft = savedNextDraft ?? {
        ...currentDraft(nextWorkspaceId),
        sessionName: '',
        message: '',
        document: EMPTY_COMPOSER_DOCUMENT,
      };
      const nextDocument = newSessionComposerDocument(nextDraft);
      setDraft(nextDraft);
      setSelectedWs(nextWorkspaceId);
      setSessionName(nextDraft.sessionName ?? '');
      setComposerDocument(nextDocument);
      setMessage(composerDocumentUserText(nextDocument));
      setContextItems(savedContextItems(nextDraft.contextItems));
      setScreenshotAttachments(nextDraft.screenshotAttachments ?? []);
      attachmentIdsRef.current = new Set(nextDraft.screenshotAttachments?.map(item => item.id) ?? []);
      editorRef.current?.setDocument(nextDocument);
      setAgentId(nextDraft.agentId ?? null);
      setModel(nextDraft.model ?? '');
      setEffort(nextDraft.thinkingEffort ?? null);
      setMode(nextDraft.approvalMode ?? null);
      setServiceTier(nextDraft.serviceTier ?? null);
    }
    wsDrop.setOpen(false);
  }

  const canSend = !!selectedWorkspace
    && selectedWorkspace.hidden !== 1
    && selectedAgent?.ready === true
    && (composerDocument.segments.length > 0)
    && !creating
    && !preparingAttachments
    && !createUnknown;

  async function submit() {
    if (!canSend || !executor) return;
    const owner = activeDraftScope();
    if (!owner) return;
    setPreparingAttachments(true);
    setAttachmentError(null);
    const referenceIds = newSessionReferenceIds(composerDocument);
    const referencedAttachments = screenshotAttachments.filter(item => referenceIds.has(item.id));
    const referencedContextItems = contextItems.filter(item => referenceIds.has(item.id));
    const firstAttachments: NewSessionFirstAttachment[] = [];
    try {
      for (const attachment of referencedAttachments) {
        const blob = await loadNewSessionScreenshotBlob(owner, attachment.id);
        if (!blob) throw new Error(`missing screenshot blob: ${attachment.id}`);
        firstAttachments.push({ ...attachment, blob });
      }
    } catch {
      setAttachmentError(t('screenshot.restoreFailed'));
      setPreparingAttachments(false);
      return;
    }
    const catalogReady = catalog.configOptions.length > 0;
    const values: Record<string, ConfigValue> = { ...catalogValues };
    if (catalogReady) {
      for (const option of catalog.configOptions) {
        if (option.role === 'model' && model) values[option.id] = model;
        else if (
          option.role === 'effort'
          && effort
          && option.choices?.some(choice => Object.is(choice.value, effort))
        ) values[option.id] = effort;
        else if (option.role === 'approval_mode' && mode) values[option.id] = mode;
        else if (option.role === 'fast') values[option.id] = serviceTier === 'fast';
      }
    }
    const payload = buildSessionCreatePayload({
      workspaceId: selectedWs,
      sessionName,
      ...(selectedAgent ? { agentId: selectedAgent.id } : {}),
      executor,
      model: cliExecutor || catalogReady ? model : undefined,
      thinkingEffort: cliExecutor || catalogReady ? effort : undefined,
      approvalMode: cliExecutor ? mode : undefined,
      serviceTier: executor === 'codex' || optionByRole(catalog.configOptions, 'fast')
        ? serviceTier
        : undefined,
      ...(catalogReady
        ? { catalogOptions: catalog.configOptions, catalogValues: values }
        : {}),
    });
    writeJson(LAST_KEY, {
      workspaceId: selectedWs,
      ...(selectedAgent ? { agentId: selectedAgent.id } : {}),
      executor,
      ...(payload.model ? { model: payload.model } : {}),
      ...(payload.thinkingEffort ? { thinkingEffort: payload.thinkingEffort } : {}),
      ...(payload.approvalMode ? { approvalMode: payload.approvalMode } : {}),
      ...(payload.serviceTier ? { serviceTier: payload.serviceTier } : {}),
    });
    onCreate({
      ...payload,
      firstMessage: composerDocumentUserText(composerDocument).trim(),
      ...(composerDocument.segments.some(segment => segment.type === 'reference')
        ? { composerDocument }
        : {}),
      ...(firstAttachments.length > 0 ? { firstAttachments } : {}),
      ...(referencedContextItems.length > 0 ? { contextItems: referencedContextItems } : {}),
    });
    setPreparingAttachments(false);
    // The text stays put on failure (the form stays open with the error);
    // CodingView unmounts this view once the create run confirms.
  }

  function startNewWorkspace() {
    wsDrop.setOpen(false);
    // The continuous draft already owns the full form. Keep the return flag
    // so App can reopen the page with the newly created Workspace selected.
    const owner = activeDraftScope();
    if (owner) writeJson(newSessionDraftStorageKey(owner), currentDraft());
    try { localStorage.setItem(RETURN_KEY, '1'); } catch { /* best-effort */ }
    onNewWorkspace();
  }

  function handleMessageKeyDown(event: KeyboardEvent): boolean {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submit();
      return true;
    }
    return false;
  }

  function handleDocumentChange(nextDocument: ComposerDocument, userText: string): void {
    setComposerDocument(nextDocument);
    setMessage(userText);
    const referenceIds = newSessionReferenceIds(nextDocument);
    if (activeReference && !referenceIds.has(activeReference.id)) setActiveReference(null);
  }

  function removeScreenshot(id: string): void {
    const owner = activeDraftScope();
    if (!owner) return;
    editorRef.current?.removeReference(id);
    setScreenshotAttachments(previous => previous.filter(item => item.id !== id));
    attachmentIdsRef.current.delete(id);
    void removeNewSessionScreenshot(owner, id);
  }

  function removeContextItem(id: string): void {
    editorRef.current?.removeReference(id);
    setContextItems(previous => previous.filter(item => item.id !== id));
  }

  const activeContextItem = activeReference
    ? contextItems.find(item => item.id === activeReference.id) ?? null
    : null;
  const activeScreenshot = activeReference
    ? screenshotAttachments.find(item => item.id === activeReference.id) ?? null
    : null;
  const activeScreenshotThumb = activeScreenshot
    ? screenshotPreviews[activeScreenshot.id]
    : undefined;

  async function pickComposerResources(): Promise<void> {
    addDrop.setOpen(false);
    setResourcePicking(true);
    setAttachmentError(null);
    try {
      if (!operationDispatch || !operationStore) {
        setAttachmentError(t('composer.context.pickerUnavailable'));
        return;
      }
      const run = operationDispatch('context.pickResources', {});
      const settled = await waitForRunSettle(operationStore, run.id);
      if (settled.phase !== 'confirmed') {
        setAttachmentError(t('composer.context.pickerUnavailable'));
        return;
      }
      const result = settled.result as PickComposerResourcesResult | undefined;
      if (!result) return;
      if (result.rejectedFiles.length > 0) {
        setAttachmentError(t('composer.context.filesRejected'));
      }
      const folders = result.resources.filter(resource => resource.type === 'folder');
      const paths = new Set(contextItems.flatMap(item => item.type === 'folder' ? [item.path] : []));
      const additions: MessageContextItem[] = folders
        .filter(folder => {
          if (paths.has(folder.path)) return false;
          paths.add(folder.path);
          return true;
        })
        .map(folder => ({
          type: 'folder' as const,
          id: crypto.randomUUID(),
          path: folder.path,
          name: folder.name,
        }))
        .slice(0, Math.max(0, MAX_MESSAGE_CONTEXT_ITEMS - contextItems.length));
      setContextItems(previous => [...previous, ...additions]);
      for (const item of additions) {
        editorRef.current?.insertReference({
          id: item.id,
          referenceType: 'context',
          label: newSessionContextLabel(item),
        });
      }
      const files = result.resources.flatMap(resource => resource.type === 'file'
        ? [new File([new Uint8Array(resource.data)], resource.name, { type: resource.mime })]
        : []);
      if (files.length > 0) await addFiles(files);
    } finally {
      setResourcePicking(false);
    }
  }

  /** Paste/picker entry point, mirroring the session Composer's pipeline but
   *  staged in the pre-session Blob store — the session does not exist yet, so
   *  there is nothing to upload to. `storeNewSessionAttachment` dispatches the
   *  screenshot event, which the listener above uses to refresh chip state. */
  async function addFiles(files: File[]): Promise<void> {
    const owner = activeDraftScope();
    if (!owner || files.length === 0) return;
    setAttachmentError(null);
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) {
        setAttachmentError(t('composer.attachment.tooLarge'));
        continue;
      }
      try {
        await storeNewSessionAttachment(owner, { name: file.name, blob: file });
      } catch {
        setAttachmentError(t('screenshot.restoreFailed'));
      }
    }
  }

  function handlePaste(event: ClipboardEvent): boolean {
    const items = Array.from(event.clipboardData?.items ?? []);
    const images = items.filter(item => item.kind === 'file' && item.type.startsWith('image/'));
    if (images.length > 0) {
      event.preventDefault();
      const takenNames = new Set(screenshotAttachments.map(attachment => attachment.name));
      const files = images
        .map(item => item.getAsFile())
        .filter((file): file is File => file !== null)
        .map(file => {
          const name = dedupeAttachmentName(file.name || `paste-${Date.now()}.png`, takenNames);
          takenNames.add(name);
          return new File([file], name, { type: file.type });
        });
      void addFiles(files);
      return true;
    }
    const pastedText = typeof event.clipboardData?.getData === 'function'
      ? event.clipboardData.getData('text/plain')
      : '';
    const lineCount = pastedText ? pastedText.split(/\r\n|\r|\n/).length : 0;
    if (
      !pastedText
      || (pastedText.length <= PASTED_TEXT_CARD_MIN_CHARS && lineCount <= PASTED_TEXT_CARD_MIN_LINES)
      || contextItems.length >= MAX_MESSAGE_CONTEXT_ITEMS
    ) return false;
    const byteSize = new Blob([pastedText]).size;
    if (byteSize > MAX_PASTED_TEXT_BYTES) {
      if (!canAttachLocalFile) return false;
      event.preventDefault();
      void addFiles([new File(
        [pastedText],
        `pasted-text-${Date.now()}.txt`,
        { type: 'text/plain' },
      )]);
      return true;
    }
    event.preventDefault();
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
      label: newSessionContextLabel(item),
    });
    return true;
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>): void {
    void addFiles(Array.from(event.target.files ?? []));
    // Reset input so the same file can be re-selected.
    event.target.value = '';
  }

  function handleTitleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      editorRef.current?.focus();
    }
  }

  return (
    <main className="main">
      <div className="main-head session-chat-head">
        <div className="main-head-l">
          <span className="main-title">{t('coding.new.title')}</span>
        </div>
        <div className="main-head-r">
          <button className="btn ghost sm" onClick={onCancel} disabled={creating}>{t('coding.new.cancel')}</button>
        </div>
      </div>
      <div className="main-scroll">
        <div className="ns-center">
          {createError && (
            <p className="spaces-error" role="alert" data-testid="session-create-error">
              {createError}
            </p>
          )}
          {attachmentError && (
            <p className="spaces-error" role="alert" data-testid="new-session-attachment-error">
              {attachmentError}
            </p>
          )}
          {catalogResolveError && (
            <p className="spaces-error" role="alert" data-testid="new-session-catalog-error">
              {catalogResolveError}
            </p>
          )}
          {createUnknown && onVerifyCreate && (
            <button
              type="button"
              className="btn secondary sm"
              data-testid="session-create-refresh"
              disabled={verifyingCreate}
              onClick={onVerifyCreate}
            >
              {verifyingCreate ? 'Refreshing sessions…' : 'Refresh sessions before retrying'}
            </button>
          )}
        </div>
      </div>

      <div className="composer-wrap">
        {/* Agent + workspace selection live ABOVE the message box (issue #57
            v2 review); the picked agent drives the chips inside the bar. */}
          <div className="ns-agent-row" data-testid="ns-agent-row">
          {agents === null ? (
            <span className="composer-opt" data-testid="ns-agent-loading">
              <span className="name">{t('common.loading')}</span>
            </span>
          ) : (agents?.length ?? 0) === 0 ? (
            <span className="composer-opt" data-testid="ns-agent-empty">
              <span className="name">{t('coding.new.executor.none')}</span>
            </span>
          ) : showAgentPicker ? (
            <button
              ref={agentDrop.btnRef}
              type="button"
              className={`composer-opt ns-agent-btn${agentDrop.open ? ' open' : ''}`}
              data-testid="ns-agent-picker"
              title={t('coding.new.agent.title')}
              onClick={() => agentDrop.setOpen(open => !open)}
            >
              {selectedAgent && (
                <AgentLogo proxy={selectedAgent.proxy} size={18} />
              )}
              <span className="name">
                {selectedAgent ? selectedAgent.name : t('coding.new.agent.select')}
              </span>
              <span className="caret cmp-caret" aria-hidden="true">▾</span>
            </button>
          ) : selectedAgent ? (
            <span className="composer-opt ns-chip-static" data-testid="ns-agent-picker">
              <AgentLogo proxy={selectedAgent.proxy} size={18} />
              <span className="name">{selectedAgent.name}</span>
            </span>
          ) : null}

          {selectedAgent?.runtimeProfile?.verification === 'unverified' && (
            <p className="ns-runtime-warning" role="alert" data-testid="ns-runtime-unverified">
              {t('coding.new.agent.unverified')}
            </p>
          )}

          <button
            ref={wsDrop.btnRef}
            type="button"
            className={`composer-opt ns-ws-btn${wsDrop.open ? ' open' : ''}`}
            data-testid="ns-workspace-chip"
            title={t('coding.new.workspace.title')}
            onClick={() => wsDrop.setOpen(open => !open)}
            >
              <FolderIcon />
              <span className="name">
                {selectedWorkspace ? selectedWorkspace.name : t('coding.new.workspace.choose')}
              </span>
              <span className="caret cmp-caret" aria-hidden="true">▾</span>
            </button>

            {sessionExtras.length > 0 && (
              <div className="composer-native-config ns-session-config" data-testid="ns-session-config">
                {sessionExtras.map(option => (
                  <SessionCatalogOptionControl
                    key={option.id}
                    option={option}
                    value={catalogValues[option.id] ?? option.defaultValue}
                    disabled={creating}
                    onChange={value => setCatalogValues(current => ({
                      ...current,
                      [option.id]: value,
                    }))}
                  />
                ))}
              </div>
            )}
          </div>
        {agentDrop.open && agentDrop.pos && agents && createPortal(
          <div
            ref={agentDrop.popRef}
            className="popover"
            role="dialog"
            style={{ left: agentDrop.pos.left, bottom: agentDrop.pos.bottom }}
          >
            <div className="mp-section-head">
              <span className="mp-section-title">{t('coding.new.agent.title')}</span>
            </div>
            <div className="mp-list">
              {readyAgents.map(agent => (
                <button
                  key={agent.id}
                  type="button"
                  className={`mp-row${agentId === agent.id ? ' active' : ''}`}
                  data-testid={`ns-agent-option-${agent.id}`}
                  onClick={() => { setAgentId(agent.id); agentDrop.setOpen(false); }}
                >
                  <span className="mp-check">{agentId === agent.id ? '✓' : ''}</span>
                  <AgentLogo proxy={agent.proxy} size={24} />
                  <span className="mp-row-body">
                    <span className="mp-row-title">{agent.name}</span>
                    <span className={`mp-row-hint${agent.runtimeProfile?.verification === 'unverified' ? ' danger-text' : ''}`}>
                      {agent.runtimeProfile?.verification === 'unverified'
                        ? `${agent.proxyName} · ${t('coding.new.agent.unverifiedShort')}`
                        : agent.proxyName}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
        {wsDrop.open && wsDrop.pos && createPortal(
          <div
            ref={wsDrop.popRef}
            className="popover ns-ws-pop"
            role="dialog"
            style={{ left: wsDrop.pos.left, bottom: wsDrop.pos.bottom }}
          >
            <div className="ns-ws-search">
              <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor"
                   strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
              <input
                className="ns-ws-search-input"
                data-testid="ns-workspace-search"
                placeholder={t('coding.new.workspace.search')}
                value={wsQuery}
                autoFocus
                spellCheck={false}
                onChange={event => setWsQuery(event.target.value)}
              />
            </div>
            <div className="mp-list ns-ws-list">
              {filteredWs.map(workspace => (
                <button
                  key={workspace.id}
                  type="button"
                  className={`mp-row${selectedWs === workspace.id ? ' active' : ''}`}
                  data-testid={`ns-workspace-option-${workspace.id}`}
                  disabled={workspace.hidden === 1}
                  onClick={() => pickWorkspace(workspace.id)}
                >
                  <span className="mp-check">{selectedWs === workspace.id ? '✓' : ''}</span>
                  <span className="mp-row-body">
                    <span className="mp-row-title">{workspace.name}</span>
                    <span className="mp-row-hint">{workspace.path}</span>
                  </span>
                </button>
              ))}
              {filteredWs.length === 0 && (
                <div className="mp-row" style={{ color: 'var(--text-3)', cursor: 'default' }}>
                  <span className="mp-row-body">
                    <span className="mp-row-title">{t('coding.new.workspace.empty')}</span>
                  </span>
                </div>
              )}
            </div>
            <button
              type="button"
              className="ns-ws-new"
              data-testid="ns-workspace-new"
              onClick={startNewWorkspace}
            >
              <span aria-hidden="true">+</span>
              <span>{t('coding.new.workspace.new')}</span>
            </button>
          </div>,
          document.body,
        )}

        <div className="composer">
          {/* Hidden file input — triggered by the plus button */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            data-testid="ns-file-input"
            style={{ display: 'none' }}
            onChange={handleFileChange}
            aria-hidden="true"
            tabIndex={-1}
          />
          <div className="composer-input-wrap">
            <input
              className="ns-title-input"
              data-testid="ns-title-input"
              aria-label={t('coding.new.sessionTitle')}
              autoComplete="off"
              spellCheck={false}
              value={sessionName}
              onChange={event => setSessionName(event.target.value)}
              onKeyDown={handleTitleKeyDown}
              placeholder={t('coding.new.sessionTitle.placeholder')}
            />
            <InlineComposerEditor
              ref={editorRef}
              testId="ns-message-input"
              autoFocus
              initialDocument={initial.composerDocument}
              disabled={creating || preparingAttachments || createUnknown}
              onChange={handleDocumentChange}
              onKeyDown={handleMessageKeyDown}
              onPaste={handlePaste}
              placeholder={t('coding.new.message.placeholder')}
              onReferenceActivate={(id, _referenceType, anchorEl) => setActiveReference(previous => previous?.id === id
                ? null
                : { id, anchor: anchorEl.getBoundingClientRect(), anchorEl })}
            />
          </div>
          {activeReference && activeContextItem && (
            <ContextReferencePopover
              item={activeContextItem}
              anchor={activeReference.anchor}
              anchorEl={activeReference.anchorEl}
              onClose={() => setActiveReference(null)}
              onRemove={removeContextItem}
            />
          )}
          {activeReference && activeScreenshot && (
            <ReferencePopover
              anchor={activeReference.anchor}
              anchorEl={activeReference.anchorEl}
              onClose={() => setActiveReference(null)}
            >
              <ReferencePopoverHead
                icon={REFERENCE_ICONS.file}
                title={activeScreenshot.name}
                onRemove={() => removeScreenshot(activeScreenshot.id)}
                removeLabel={t('composer.attachment.remove')}
                onClose={() => setActiveReference(null)}
              />
              <div className="ref-pop-body" data-testid="new-session-screenshots">
                {isNativeImageMime(activeScreenshot.mime) && (
                  activeScreenshotThumb ? (
                    <img
                      className="ref-pop-thumb"
                      src={activeScreenshotThumb}
                      alt={activeScreenshot.name}
                      onClick={() => zoomImage?.(activeScreenshotThumb, activeScreenshot.name)}
                    />
                  ) : (
                    <span className="spinner" aria-label={t('common.loading')} />
                  )
                )}
                <span className="ref-pop-meta">{fmtBytes(activeScreenshot.size)}</span>
              </div>
            </ReferencePopover>
          )}
          <div className="composer-bar">
            {showModelChip && executor && (
              <>
                <button
                  ref={modelDrop.btnRef}
                  type="button"
                  className={`composer-opt cmp-model-btn${modelDrop.open ? ' open' : ''}`}
                  data-testid="ns-model-chip"
                  title={t('composer.model.section')}
                  disabled={creating}
                  onClick={() => modelDrop.setOpen(open => !open)}
                >
                  <span className="name cmp-model">
                    {modelLabel(displayModels, displayModel) || displayModel}
                  </span>
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
                      {displayModels.filter(candidate => !candidate.hidden).map(candidate => {
                        const active = candidate.model === displayModel
                          || claudeModelFamily(displayModel) === candidate.model;
                        return (
                          <button
                            key={candidate.model}
                            type="button"
                            className={`mp-row${active ? ' active' : ''}`}
                            onClick={() => {
                              pickModel(candidate.model);
                              modelDrop.setOpen(false);
                            }}
                          >
                            <span className="mp-check">{active ? '✓' : ''}</span>
                            <span className="mp-row-body">
                              <span className="mp-row-title">{candidate.displayName}</span>
                              {candidate.description && executor !== 'codex' && (
                                <span className="mp-row-hint">{candidate.description}</span>
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
            {showNativeStatic && (
              <span className="composer-opt ns-chip-static cmp-model-btn" data-testid="ns-model-chip">
                <span className="name cmp-model">
                  {nativeDefaults?.model.trim() || t('coding.new.chip.default')}
                </span>
              </span>
            )}

            {modelControlVisible && effortControlVisible && <ControlSeparator />}

            {showEffortChip && executor && (
              <>
                <button
                  ref={thinkDrop.btnRef}
                  type="button"
                  className={`composer-opt cmp-think-btn${thinkDrop.open ? ' open' : ''}`}
                  data-testid="ns-thinking-chip"
                  title={t('composer.reasoning.effort')}
                  disabled={creating}
                  onClick={() => thinkDrop.setOpen(open => !open)}
                >
                  <span className="name">{effortLabel(executor, displayEffort)}</span>
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
                      {(turnEffort?.choices?.map(choice => String(choice.value))
                        ?? supportedEfforts(currentModelMeta)).map(level => (
                        <button
                          key={level}
                          type="button"
                          className={`mp-row${displayEffort === level ? ' active' : ''}`}
                          onClick={() => {
                            setEffort(level);
                            thinkDrop.setOpen(false);
                          }}
                        >
                          <span className="mp-check">{displayEffort === level ? '✓' : ''}</span>
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
            {showNativeStatic && (
              <span className="composer-opt ns-chip-static cmp-think-btn" data-testid="ns-thinking-chip">
                <span className="name">
                  {nativeDefaults?.thinking.trim() || t('coding.new.chip.default')}
                </span>
              </span>
            )}

            {showFastChip && (modelControlVisible || effortControlVisible) && <ControlSeparator />}

            {showFastChip && (
              <button
                type="button"
                className={`composer-opt cmp-fast${serviceTier === 'fast' ? ' on' : ''}`}
                data-testid="ns-fast-chip"
                title={turnFast?.description ?? t('composer.fast.title')}
                aria-pressed={serviceTier === 'fast'}
                disabled={creating || !fastEnabled}
                onClick={() => setServiceTier(current => current === 'fast' ? null : 'fast')}
              >
                {turnFast?.displayName ?? t('composer.fast.button')}
              </button>
            )}

            <span className="spacer" />

            {showApprovalChip && (
              <>
                <button
                  ref={modeDrop.btnRef}
                  type="button"
                  className={`composer-opt cmp-approval-btn${modeDrop.open ? ' open' : ''}`}
                  data-testid="ns-mode-chip"
                  title={t('composer.approval.title')}
                  onClick={() => modeDrop.setOpen(open => !open)}
                >
                  <span className="name">
                    {composerModeLabel(executor ?? 'claude', displayMode, advertisedModes, t)}
                  </span>
                </button>
                {modeDrop.open && modeDrop.pos && createPortal(
                  <div
                    ref={modeDrop.popRef}
                    className="popover approval-pop"
                    role="dialog"
                    style={{ left: modeDrop.pos.left, bottom: modeDrop.pos.bottom }}
                  >
                    <div className="mp-section-head">
                      <span className="mp-section-title">
                        {cliExecutor === 'codex'
                          ? t('composer.approval.section')
                          : t('composer.mode.title')}
                      </span>
                    </div>
                    <div className="mp-list">
                      {modeOptions.map(opt => {
                        const active = displayMode === opt.mode;
                        const title = opt.titleKey ? t(opt.titleKey) : (opt.label ?? opt.key);
                        const hint = opt.descKey
                          ? t(opt.descKey)
                          : (!opt.titleKey && opt.description ? opt.description : null);
                        return (
                          <button
                            key={opt.key}
                            type="button"
                            className={`mp-row${active ? ' active' : ''}`}
                            onClick={() => { setMode(opt.mode); modeDrop.setOpen(false); }}
                          >
                            <span className="mp-check">{active ? '✓' : ''}</span>
                            <span className="mp-row-body">
                              <span className="mp-row-title">{title}</span>
                              {hint && <span className="mp-row-hint">{hint}</span>}
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
            {showNativeStatic && (
              <span className="composer-opt ns-chip-static" data-testid="ns-mode-chip">
                <span className="name">{nativeDefaults?.mode.trim() || t('coding.new.chip.default')}</span>
              </span>
            )}

            {/* Add resources - same files/folder menu as the session Composer. */}
            <>
              <button
                ref={addDrop.btnRef}
                type="button"
                className={`composer-act${addDrop.open ? ' active' : ''}`}
                data-testid="ns-attach-button"
                disabled={creating || preparingAttachments || createUnknown || resourcePicking}
                title={t('composer.context.add')}
                onClick={() => addDrop.setOpen(open => !open)}
                aria-label={t('composer.context.add')}
              >
                {resourcePicking ? <span className="spinner" aria-hidden="true" /> : (
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

            <button
              type="button"
              className="composer-act primary"
              data-testid="ns-send"
              disabled={!canSend}
              onClick={submit}
              title={t('composer.send.button')}
              aria-label={t('composer.send.button')}
            >
              {creating || preparingAttachments ? (
                <span className="spinner" aria-hidden="true" />
              ) : (
                <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M2.5 7l9-4.5-3 9-2-3.5-4-1.5z" fill="currentColor" stroke="currentColor" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

function SessionCatalogOptionControl({
  option,
  value,
  disabled,
  onChange,
}: {
  option: ConfigOption;
  value: ConfigValue | undefined;
  disabled: boolean;
  onChange: (value: ConfigValue) => void;
}) {
  if (option.control === 'boolean') {
    return (
      <label className="composer-native-toggle" title={option.description}>
        <span>{option.displayName}</span>
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          aria-label={option.displayName}
          onChange={event => onChange(event.target.checked)}
        />
      </label>
    );
  }
  if (option.control === 'select') {
    return (
      <label className="composer-native-select" title={option.description}>
        <span>{option.displayName}</span>
        <select
          aria-label={option.displayName}
          value={String(value ?? '')}
          disabled={disabled}
          onChange={event => {
            const selected = option.choices?.find(choice => (
              String(choice.value ?? '') === event.target.value
            ));
            onChange(selected ? selected.value : event.target.value);
          }}
        >
          {(option.choices ?? []).map(choice => (
            <option key={String(choice.value)} value={String(choice.value ?? '')}>
              {choice.displayName}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="composer-native-input" title={option.description}>
      <span>{option.displayName}</span>
      <input
        key={`${option.id}:${String(value)}`}
        type={option.presentation?.sensitive
          ? 'password'
          : option.control === 'number' ? 'number' : 'text'}
        defaultValue={String(value ?? '')}
        disabled={disabled}
        aria-label={option.displayName}
        placeholder={option.presentation?.placeholder}
        min={option.constraints?.minimum}
        max={option.constraints?.maximum}
        step={option.constraints?.step}
        onBlur={event => onChange(
          option.control === 'number' ? Number(event.target.value) : event.target.value,
        )}
      />
    </label>
  );
}
