import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  AgentInstallStatus,
  ApprovalMode,
  Executor,
  ProxyModeCapabilities,
  ThinkingEffort,
  Workspace,
} from '@gian/shared';
import { usesNativeExecutorConfig } from '@gian/shared';
import { loadAgents, peekAgents } from '../api.js';
import { MAX_FILE_BYTES, fmtBytes, isNativeImageMime } from '../attachments.js';
import { desktopBridge } from '../desktop-bridge.js';
import { toast } from '../feedback.js';
import { useT } from '../i18n/index.js';
import {
  claudeModelFamily,
  composerModeLabel,
  composerModeOptions,
  defaultEffort,
  defaultModel,
  effortLabel,
  fetchModelsCached,
  fetchModesCached,
  getModelsCached,
  getModesCached,
  modelLabel,
  supportedEfforts,
} from '../components/composer/capabilities.js';
import type { ProxyModel } from '../components/composer/capabilities.js';
import { BulbIcon, ExecutorMark, useUpDrop } from '../components/composer/option-drops.js';
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
import { publishScreenshotTarget, startScreenshotCapture } from '../screenshot-target.js';
import { ImageZoomContext } from '../transcript/items.js';

export { newSessionDraftStorageKey } from '../screenshot-drafts.js';

export interface NewSessionFirstAttachment extends NewSessionScreenshotDraftAttachment {
  blob: Blob;
}

export interface CreateSessionInput {
  workspaceId: string;
  name: string;
  executor: Executor;
  /** First user message — sent automatically once the session exists. The
   *  create payload itself stays free of it (ses-001 contract); App hands it
   *  to the `session:created` socket handler via pendingFirstMessageRef. */
  firstMessage: string;
  /** Screenshots captured before the Session exists. They are uploaded into
   *  the newly-created Session before its first structured message is sent. */
  firstAttachments?: NewSessionFirstAttachment[];
  /** Capability chips the user picked on the new-session composer; omitted
   *  fields fall back to the host's configured defaults. Kimi never carries
   *  approvalMode (executor-native configuration); serviceTier is Codex-only. */
  model?: string;
  thinkingEffort?: ThinkingEffort | null;
  approvalMode?: ApprovalMode | null;
  /** Codex-only Fast service tier. Omitted/null keeps the standard tier. */
  serviceTier?: 'fast' | null;
}

export interface SessionCreateFormState {
  workspaceId: string;
  sessionName: string;
  executor: Executor;
  model?: string;
  thinkingEffort?: ThinkingEffort | null;
  approvalMode?: ApprovalMode | null;
  serviceTier?: 'fast' | null;
}

export function buildSessionCreatePayload(
  form: SessionCreateFormState,
): Omit<CreateSessionInput, 'firstMessage'> {
  return {
    workspaceId: form.workspaceId,
    name: form.sessionName.trim(),
    executor: form.executor,
    ...(form.model ? { model: form.model } : {}),
    ...(!usesNativeExecutorConfig(form.executor) && form.approvalMode ? { approvalMode: form.approvalMode } : {}),
    ...(form.thinkingEffort ? { thinkingEffort: form.thinkingEffort } : {}),
    ...(form.executor === 'codex' && form.serviceTier === 'fast' ? { serviceTier: 'fast' as const } : {}),
  };
}

/** Display blurbs for the built-in agents. Temporary: once agents become
 *  plugins, the manifest owns this metadata and this map goes away. */
const AGENT_DESC: Record<string, string> = {
  codex: 'OpenAI · gpt-5-codex',
  claude: 'CLI plan',
  kimi: 'Moonshot AI · ACP',
  grok: 'xAI · ACP',
};

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

interface StoredNewSession {
  workspaceId?: string;
  executor?: Executor;
  model?: string;
  thinkingEffort?: ThinkingEffort | null;
  approvalMode?: ApprovalMode | null;
  serviceTier?: 'fast' | null;
}

interface NewSessionDraft extends StoredNewSession {
  sessionName?: string;
  message?: string;
  screenshotAttachments?: NewSessionScreenshotDraftAttachment[];
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

export function NewSessionView({
  workspaces,
  initialWorkspaceId,
  initialExecutor,
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
  /** Preselected agent (⌘J/⌘K "new subtask" shortcut carries the choice). */
  initialExecutor?: Executor;
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
    return { draft: saved, workspaceId };
  });
  const [draft, setDraft] = useState<NewSessionDraft | null>(initial.draft);
  const [selectedWs, setSelectedWs] = useState(initial.workspaceId);
  const [sessionName, setSessionName] = useState(draft?.sessionName ?? '');
  const [message, setMessage] = useState(draft?.message ?? '');
  const [screenshotAttachments, setScreenshotAttachments] = useState<
    NewSessionScreenshotDraftAttachment[]
  >(() => draft?.screenshotAttachments ?? []);
  const [screenshotPreviews, setScreenshotPreviews] = useState<Record<string, string>>({});
  const [preparingAttachments, setPreparingAttachments] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  /** Which agents exist and whether they're usable — driven by the host's
   *  /api/agents install status so the picker follows Settings, not a
   *  hardcoded list. Null while loading. */
  const [agents, setAgents] = useState<AgentInstallStatus[] | null>(() => peekAgents());
  const [executor, setExecutor] = useState<Executor | null>(
    initialExecutor ?? draft?.executor ?? null,
  );
  // Capability chip state (claude/codex only — kimi shows its configured
  // defaults as static text, its native options only exist on a live session).
  const [model, setModel] = useState(draft?.model ?? '');
  const [effort, setEffort] = useState<ThinkingEffort | null>(draft?.thinkingEffort ?? null);
  const [mode, setMode] = useState<ApprovalMode | null>(draft?.approvalMode ?? null);
  const [serviceTier, setServiceTier] = useState<'fast' | null>(draft?.serviceTier ?? null);
  const [models, setModels] = useState<ProxyModel[]>([]);
  const [proxyModes, setProxyModes] = useState<ProxyModeCapabilities[]>([]);
  const [wsQuery, setWsQuery] = useState('');
  const agentDrop = useUpDrop(280);
  const wsDrop = useUpDrop(320);
  const modelDrop = useUpDrop(280);
  const effortDrop = useUpDrop(210);
  const modeDrop = useUpDrop(340);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const screenshotAvailable = !!desktopBridge()?.screenshot;

  useEffect(() => {
    let cancelled = false;
    loadAgents()
      .then(list => { if (!cancelled) setAgents(list); })
      .catch(() => { if (!cancelled) setAgents([]); });
    return () => { cancelled = true; };
  }, []);

  // Agent default: explicit preselect (⌘J/⌘K) > restored draft > last-used
  // (still ready) > the single ready agent (auto-selected, picker static).
  // With several ready agents and no memory, nothing is selected and Send
  // stays disabled.
  useEffect(() => {
    if (!agents || executor) return;
    const remembered = draft?.executor ?? last?.executor;
    if (remembered && agents.some(a => a.id === remembered && a.ready)) {
      setExecutor(remembered);
      return;
    }
    const ready = agents.filter(agent => agent.ready);
    if (ready.length === 1) setExecutor(ready[0]!.id);
  }, [agents, executor, draft, last]);

  // Chip state holds ONLY explicit choices (restored draft / last-used values
  // for this agent, or rows the user picks from a drop). Display falls back
  // to the Settings-managed proxy defaults, then the capability list's own
  // defaults; the create payload carries only explicit choices so the host's
  // configured defaults stay authoritative otherwise. Models/modes load
  // lazily per executor (cached).
  useEffect(() => {
    if (!executor || usesNativeExecutorConfig(executor)) {
      setModels([]);
      setProxyModes([]);
      setServiceTier(null);
      return;
    }
    const cli = executor;
    const remembered = draft?.executor === cli
      ? draft
      : (last?.executor === cli ? last : null);
    setModels(getModelsCached(cli) ?? []);
    setProxyModes(getModesCached(cli) ?? []);
    setModel(remembered?.model ?? '');
    setEffort(remembered?.thinkingEffort ?? null);
    setMode(remembered?.approvalMode ?? null);
    setServiceTier(cli === 'codex' ? (remembered?.serviceTier ?? null) : null);

    let alive = true;
    void fetchModelsCached(cli)
      .then(list => { if (alive) setModels(list); })
      .catch(() => { /* chips keep the built-in fallbacks */ });
    void fetchModesCached(cli)
      .then(list => { if (alive) setProxyModes(list); })
      .catch(() => { /* built-in mode lists */ });
    return () => { alive = false; };
  }, [executor, draft, last]);

  function currentDraft(workspaceId = selectedWs): NewSessionDraft {
    return {
      workspaceId,
      sessionName,
      message,
      ...(screenshotAttachments.length > 0 ? { screenshotAttachments } : {}),
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
      setScreenshotAttachments(detail.attachments);
      setAttachmentError(null);
      requestAnimationFrame(() => taRef.current?.focus());
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

  // Auto-grow the message box, same 160px cap as the session Composer.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(160, el.scrollHeight) + 'px';
  }, [message]);

  const selectedAgent = agents?.find(agent => agent.id === executor) ?? null;
  const readyAgents = (agents ?? []).filter(agent => agent.ready);
  // Exactly one usable agent: no choice to make — the chip shows it
  // statically (issue #57). Zero or 2+ ready agents get the picker drop
  // (not-ready rows render disabled).
  const showAgentPicker = readyAgents.length !== 1;
  const cliExecutor = executor && usesNativeExecutorConfig(executor) ? null : executor;
  const cliDefaults = cliExecutor
    ? agents?.find(a => a.id === cliExecutor)?.proxy?.defaults
    : undefined;
  // Display fallbacks: explicit chip state > Settings proxy defaults >
  // capability-list defaults.
  const displayModel = model
    || cliDefaults?.model.trim()
    || (cliExecutor ? defaultModel(models, cliExecutor) : '');
  const currentModelMeta = models.find(m => m.model === displayModel)
    ?? models.find(m => m.isDefault)
    ?? models[0];
  const displayEffort = effort
    ?? ((cliDefaults?.thinking.trim() || null) as ThinkingEffort | null)
    ?? defaultEffort(currentModelMeta);
  const displayMode = mode
    ?? ((cliDefaults?.mode.trim() || null) as ApprovalMode | null)
    ?? 'ask';
  const modeOptions = cliExecutor ? composerModeOptions(cliExecutor, proxyModes) : [];
  const nativeDefaults = executor && usesNativeExecutorConfig(executor)
    ? agents?.find(a => a.id === executor)?.proxy?.defaults
    : undefined;

  const wsRows = workspaces.filter(w => w.name !== '__gian_root__');
  const query = wsQuery.trim().toLowerCase();
  const filteredWs = query
    ? wsRows.filter(w => w.name.toLowerCase().includes(query))
    : wsRows;

  function pickModel(next: string) {
    setModel(next);
    const meta = models.find(m => m.model === next);
    const efforts = supportedEfforts(meta);
    // Keep an explicit effort only when the new model supports it.
    if (effort && efforts.length > 0 && !efforts.includes(effort)) {
      setEffort(defaultEffort(meta));
    }
    modelDrop.setOpen(false);
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
      };
      setDraft(nextDraft);
      setSelectedWs(nextWorkspaceId);
      setSessionName(nextDraft.sessionName ?? '');
      setMessage(nextDraft.message ?? '');
      setScreenshotAttachments(nextDraft.screenshotAttachments ?? []);
      setExecutor(nextDraft.executor ?? null);
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
    && (!!message.trim() || screenshotAttachments.length > 0)
    && !creating
    && !preparingAttachments
    && !createUnknown;

  async function submit() {
    if (!canSend || !executor) return;
    const owner = activeDraftScope();
    if (!owner) return;
    setPreparingAttachments(true);
    setAttachmentError(null);
    const firstAttachments: NewSessionFirstAttachment[] = [];
    try {
      for (const attachment of screenshotAttachments) {
        const blob = await loadNewSessionScreenshotBlob(owner, attachment.id);
        if (!blob) throw new Error(`missing screenshot blob: ${attachment.id}`);
        firstAttachments.push({ ...attachment, blob });
      }
    } catch {
      setAttachmentError(t('screenshot.restoreFailed'));
      setPreparingAttachments(false);
      return;
    }
    const payload = buildSessionCreatePayload({
      workspaceId: selectedWs,
      sessionName,
      executor,
      model: cliExecutor ? model : undefined,
      thinkingEffort: cliExecutor ? effort : undefined,
      approvalMode: cliExecutor ? mode : undefined,
      serviceTier: executor === 'codex' ? serviceTier : undefined,
    });
    writeJson(LAST_KEY, {
      workspaceId: selectedWs,
      executor,
      ...(payload.model ? { model: payload.model } : {}),
      ...(payload.thinkingEffort ? { thinkingEffort: payload.thinkingEffort } : {}),
      ...(payload.approvalMode ? { approvalMode: payload.approvalMode } : {}),
      ...(payload.serviceTier ? { serviceTier: payload.serviceTier } : {}),
    });
    onCreate({
      ...payload,
      firstMessage: message.trim(),
      ...(firstAttachments.length > 0 ? { firstAttachments } : {}),
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

  function handleMessageKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  async function captureScreenshot(): Promise<void> {
    try {
      await startScreenshotCapture();
    } catch {
      toast({ kind: 'error', message: t('screenshot.startFailed') });
    }
  }

  function removeScreenshot(id: string): void {
    const owner = activeDraftScope();
    if (!owner) return;
    setScreenshotAttachments(previous => previous.filter(item => item.id !== id));
    void removeNewSessionScreenshot(owner, id);
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

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const items = Array.from(event.clipboardData?.items ?? []);
    const images = items.filter(item => item.kind === 'file' && item.type.startsWith('image/'));
    if (images.length === 0) return; // let normal text paste through
    event.preventDefault();
    const files = images
      .map(item => item.getAsFile())
      .filter((file): file is File => file !== null)
      // Screenshots have empty names — fabricate one, same as the Composer.
      .map(file => file.name ? file : new File([file], `paste-${Date.now()}.png`, { type: file.type }));
    void addFiles(files);
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>): void {
    void addFiles(Array.from(event.target.files ?? []));
    // Reset input so the same file can be re-selected.
    event.target.value = '';
  }

  function handleTitleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      taRef.current?.focus();
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
        <div className="ns-agent-row">
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
              {selectedAgent && <ExecutorMark executor={selectedAgent.id} />}
              <span className="name">
                {selectedAgent ? selectedAgent.name : t('coding.new.agent.select')}
              </span>
              <span className="caret cmp-caret" aria-hidden="true">▾</span>
            </button>
          ) : selectedAgent ? (
            <span className="composer-opt ns-chip-static" data-testid="ns-agent-picker">
              <ExecutorMark executor={selectedAgent.id} />
              <span className="name">{selectedAgent.name}</span>
            </span>
          ) : null}

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
              {agents.map(agent => (
                <button
                  key={agent.id}
                  type="button"
                  className={`mp-row${executor === agent.id ? ' active' : ''}`}
                  data-testid={`ns-agent-option-${agent.id}`}
                  disabled={!agent.ready}
                  title={agent.ready ? undefined : t('coding.new.executor.notReady')}
                  onClick={() => { setExecutor(agent.id); agentDrop.setOpen(false); }}
                >
                  <span className="mp-check">{executor === agent.id ? '✓' : ''}</span>
                  <span className="mp-row-body">
                    <span className="mp-row-title">{agent.name}</span>
                    <span className="mp-row-hint">
                      {agent.ready ? (AGENT_DESC[agent.id] ?? '') : t('coding.new.executor.notReady')}
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
            <textarea
              ref={taRef}
              className="composer-ta"
              data-testid="ns-message-input"
              rows={1}
              autoFocus
              value={message}
              onChange={event => setMessage(event.target.value)}
              onKeyDown={handleMessageKeyDown}
              onPaste={handlePaste}
              placeholder={t('coding.new.message.placeholder')}
            />
          </div>
          {screenshotAttachments.length > 0 && (
            <div className="composer-attachments" data-testid="new-session-screenshots">
              {screenshotAttachments.map(attachment => {
                const thumbUrl = screenshotPreviews[attachment.id];
                return (
                <div key={attachment.id} className="att-chip">
                  {isNativeImageMime(attachment.mime) ? (
                    thumbUrl ? (
                      <button
                        type="button"
                        className="att-thumb-btn"
                        title={attachment.name}
                        onClick={() => zoomImage?.(thumbUrl, attachment.name)}
                      >
                        <img
                          className="att-thumb"
                          src={thumbUrl}
                          alt={attachment.name}
                        />
                      </button>
                    ) : (
                      <span className="spinner" aria-label={t('common.loading')} />
                    )
                  ) : (
                    <span className="att-file-icon" aria-hidden="true">
                      <svg viewBox="0 0 16 16" fill="none">
                        <path d="M4 1.75h5l3 3V14.25H4z" stroke="currentColor" strokeWidth="1.2" />
                        <path d="M9 1.75v3h3" stroke="currentColor" strokeWidth="1.2" />
                      </svg>
                    </span>
                  )}
                  <span className="att-name" title={attachment.name}>{attachment.name}</span>
                  <span className="att-size">{fmtBytes(attachment.size)}</span>
                  <button
                    className="att-remove"
                    type="button"
                    onClick={() => removeScreenshot(attachment.id)}
                    aria-label={t('composer.attachment.remove')}
                  >✕</button>
                </div>
                );
              })}
            </div>
          )}
          <div className="composer-bar">
            {/* Capability chips follow the selected agent. claude/codex get
                live model + thinking drops; Codex also gets Fast. kimi's
                native options only exist on a live ACP session, so it shows
                its configured defaults. */}
            {cliExecutor && (
              <>
                <button
                  ref={modelDrop.btnRef}
                  type="button"
                  className={`composer-opt cmp-model-wrap${modelDrop.open ? ' open' : ''}`}
                  data-testid="ns-model-chip"
                  title={t('composer.model.title')}
                  onClick={() => modelDrop.setOpen(open => !open)}
                >
                  <span className="name cmp-model">{modelLabel(models, displayModel) || displayModel}</span>
                  <span className="caret cmp-caret" aria-hidden="true">▾</span>
                </button>
                {modelDrop.open && modelDrop.pos && createPortal(
                  <div
                    ref={modelDrop.popRef}
                    className="popover model-pop"
                    role="dialog"
                    style={{ left: modelDrop.pos.left, bottom: modelDrop.pos.bottom }}
                  >
                    <div className="mp-section">
                      <div className="mp-section-head">
                        <span className="mp-section-title">{t('composer.model.section')}</span>
                        <span className="mp-section-hint">{cliExecutor}</span>
                      </div>
                      <div className="mp-list">
                        {models.length === 0 && (
                          <div className="mp-row" style={{ color: 'var(--text-3)', cursor: 'default' }}>{t('common.loading')}</div>
                        )}
                        {models.filter(m => !m.hidden).map(m => {
                          const active = m.model === displayModel
                            || (!!m.model && m.model === claudeModelFamily(displayModel));
                          return (
                            <button
                              key={m.id}
                              type="button"
                              className={`mp-row${active ? ' active' : ''}`}
                              onClick={() => pickModel(m.model)}
                            >
                              <span className="mp-check">{active ? '✓' : ''}</span>
                              <span className="mp-row-body">
                                <span className="mp-row-title">{m.displayName}</span>
                                {m.description && cliExecutor !== 'codex' && (
                                  <span className="mp-row-hint">{m.description}</span>
                                )}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>,
                  document.body,
                )}

                <button
                  ref={effortDrop.btnRef}
                  type="button"
                  className={`composer-opt cmp-think-btn${effortDrop.open ? ' open' : ''}`}
                  data-testid="ns-effort-chip"
                  title={t('composer.reasoning.effort')}
                  onClick={() => effortDrop.setOpen(open => !open)}
                >
                  <BulbIcon />
                  <span className="name">{effortLabel(cliExecutor, displayEffort)}</span>
                  <span className="caret cmp-caret" aria-hidden="true">▾</span>
                </button>
                {effortDrop.open && effortDrop.pos && createPortal(
                  <div
                    ref={effortDrop.popRef}
                    className="popover think-pop"
                    role="dialog"
                    style={{ left: effortDrop.pos.left, bottom: effortDrop.pos.bottom }}
                  >
                    <div className="mp-section-head">
                      <span className="mp-section-title">{t('composer.reasoning.effort')}</span>
                    </div>
                    <div className="mp-list">
                      {supportedEfforts(currentModelMeta).map(level => {
                        const active = displayEffort === level;
                        return (
                          <button
                            key={level}
                            type="button"
                            className={`mp-row${active ? ' active' : ''}`}
                            onClick={() => { setEffort(level); effortDrop.setOpen(false); }}
                          >
                            <span className="mp-check">{active ? '✓' : ''}</span>
                            <span className="mp-row-body">
                              <span className="mp-row-title">{effortLabel(cliExecutor, level)}</span>
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
            {executor && usesNativeExecutorConfig(executor) && (
              <>
                <span className="composer-opt ns-chip-static" data-testid="ns-model-chip">
                  <span className="name">{nativeDefaults?.model.trim() || t('coding.new.chip.default')}</span>
                </span>
                <span className="composer-opt ns-chip-static" data-testid="ns-effort-chip">
                  <BulbIcon />
                  <span className="name">{nativeDefaults?.thinking.trim() || t('coding.new.chip.default')}</span>
                </span>
              </>
            )}

            {executor === 'codex' && (
              <button
                type="button"
                className={`composer-opt cmp-fast${serviceTier === 'fast' ? ' on' : ''}`}
                data-testid="ns-fast-chip"
                title={t('composer.fast.title')}
                aria-pressed={serviceTier === 'fast'}
                onClick={() => setServiceTier(serviceTier === 'fast' ? null : 'fast')}
              >
                {t('composer.fast.button')}
              </button>
            )}

            <span className="spacer" />

            {cliExecutor && (
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
                    {composerModeLabel(cliExecutor, displayMode, proxyModes, t)}
                  </span>
                  <span className="caret cmp-caret" aria-hidden="true">▾</span>
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
            {executor && usesNativeExecutorConfig(executor) && (
              <span className="composer-opt ns-chip-static" data-testid="ns-mode-chip">
                <span className="name">{nativeDefaults?.mode.trim() || t('coding.new.chip.default')}</span>
              </span>
            )}

            {/* Attach files — plus glyph, same as the session Composer. */}
            <button
              type="button"
              className={`composer-act${screenshotAttachments.length > 0 ? ' active' : ''}`}
              data-testid="ns-attach-button"
              disabled={creating || preparingAttachments || createUnknown}
              title={t('composer.attachment.addFiles')}
              onClick={() => fileInputRef.current?.click()}
              aria-label={t('composer.attachment.addFiles')}
            >
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>

            {screenshotAvailable && (
              <button
                type="button"
                className="composer-act"
                disabled={creating || preparingAttachments || createUnknown}
                title={t('screenshot.capture')}
                aria-label={t('screenshot.capture')}
                onClick={() => { void captureScreenshot(); }}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
                  <path d="M5 3.5 6 2h4l1 1.5h2A1.5 1.5 0 0 1 14.5 5v7A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V5A1.5 1.5 0 0 1 3 3.5h2Z" strokeWidth="1.2" />
                  <circle cx="8" cy="8.5" r="2.5" strokeWidth="1.2" />
                </svg>
              </button>
            )}

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
