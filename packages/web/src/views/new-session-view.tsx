import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  AgentInstallStatus,
  ApprovalMode,
  Executor,
  ProxyModeCapabilities,
  ThinkingEffort,
  Workspace,
} from '@gian/shared';
import { loadAgents, peekAgents } from '../api.js';
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

export interface CreateSessionInput {
  workspaceId: string;
  name: string;
  executor: Executor;
  /** First user message — sent automatically once the session exists. The
   *  create payload itself stays free of it (ses-001 contract); App hands it
   *  to the `session:created` socket handler via pendingFirstMessageRef. */
  firstMessage: string;
  /** Capability chips the user picked on the new-session composer; omitted
   *  fields fall back to the host's configured defaults. Kimi never carries
   *  approvalMode (executor-native configuration). */
  model?: string;
  thinkingEffort?: ThinkingEffort | null;
  approvalMode?: ApprovalMode | null;
}

export interface SessionCreateFormState {
  workspaceId: string;
  sessionName: string;
  executor: Executor;
  model?: string;
  thinkingEffort?: ThinkingEffort | null;
  approvalMode?: ApprovalMode | null;
}

export function buildSessionCreatePayload(
  form: SessionCreateFormState,
): Omit<CreateSessionInput, 'firstMessage'> {
  return {
    workspaceId: form.workspaceId,
    name: form.sessionName.trim(),
    executor: form.executor,
    ...(form.model ? { model: form.model } : {}),
    ...(form.executor !== 'kimi' && form.approvalMode ? { approvalMode: form.approvalMode } : {}),
    ...(form.thinkingEffort ? { thinkingEffort: form.thinkingEffort } : {}),
  };
}

/** Display blurbs for the built-in agents. Temporary: once agents become
 *  plugins, the manifest owns this metadata and this map goes away. */
const AGENT_DESC: Record<string, string> = {
  codex: 'OpenAI · gpt-5-codex',
  claude: 'CLI plan',
  kimi: 'Moonshot AI · ACP',
};

/** Last-used new-session choices, remembered across opens (localStorage). */
const LAST_KEY = 'gian.new-session.last.v1';
/** Unsent draft, stashed when the user jumps to the New Workspace sheet so
 *  the return trip restores the composer exactly as it was. */
const DRAFT_KEY = 'gian.new-session.draft.v1';
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
}

interface NewSessionDraft extends StoredNewSession {
  message?: string;
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

/** Read-and-consume the stashed draft (one-shot). */
function takeNewSessionDraft(): NewSessionDraft | null {
  const draft = readJson<NewSessionDraft>(DRAFT_KEY);
  if (draft) {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* best-effort */ }
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
  taskName,
  initialExecutor,
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
  /** Task context (Tasks sidebar task-row "+" entry point): shown read-only —
   *  the new session is created as a subtask of this task. */
  taskName?: string;
  /** Preselected agent (⌘J/⌘K "new subtask" shortcut carries the choice). */
  initialExecutor?: Executor;
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
  const [draft] = useState(takeNewSessionDraft);
  const [last] = useState(() => readJson<StoredNewSession>(LAST_KEY));
  const [selectedWs, setSelectedWs] = useState(() => {
    const usable = (id: string | undefined) =>
      id !== undefined && workspaces.some(w => w.id === id && w.hidden !== 1);
    if (usable(initialWorkspaceId)) return initialWorkspaceId!;
    if (usable(last?.workspaceId)) return last!.workspaceId!;
    return workspaces.find(w => w.hidden !== 1 && w.name !== '__gian_root__')?.id ?? '';
  });
  const [message, setMessage] = useState(draft?.message ?? '');
  /** Which agents exist and whether they're usable — driven by the host's
   *  /api/agents install status so the picker follows Settings, not a
   *  hardcoded list. Null while loading. */
  const [agents, setAgents] = useState<AgentInstallStatus[] | null>(() => peekAgents());
  const [executor, setExecutor] = useState<Executor | null>(
    initialExecutor ?? draft?.executor ?? null,
  );
  // Capability chip state (claude/codex only — kimi shows its configured
  // defaults as static text, its native options only exist on a live session).
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<ThinkingEffort | null>(null);
  const [mode, setMode] = useState<ApprovalMode | null>(null);
  const [models, setModels] = useState<ProxyModel[]>([]);
  const [proxyModes, setProxyModes] = useState<ProxyModeCapabilities[]>([]);
  const [wsQuery, setWsQuery] = useState('');
  const agentDrop = useUpDrop(280);
  const wsDrop = useUpDrop(320);
  const modelDrop = useUpDrop(280);
  const effortDrop = useUpDrop(210);
  const modeDrop = useUpDrop(340);
  const taRef = useRef<HTMLTextAreaElement>(null);

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
    if (!executor || executor === 'kimi') {
      setModels([]);
      setProxyModes([]);
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

    let alive = true;
    void fetchModelsCached(cli)
      .then(list => { if (alive) setModels(list); })
      .catch(() => { /* chips keep the built-in fallbacks */ });
    void fetchModesCached(cli)
      .then(list => { if (alive) setProxyModes(list); })
      .catch(() => { /* built-in mode lists */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executor]);

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
  const cliExecutor = executor === 'kimi' ? null : executor;
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
  const kimiDefaults = executor === 'kimi'
    ? agents?.find(a => a.id === 'kimi')?.proxy?.defaults
    : undefined;

  const wsRows = workspaces.filter(w => w.name !== '__gian_root__');
  const query = wsQuery.trim().toLowerCase();
  const filteredWs = query
    ? wsRows.filter(w => w.name.toLowerCase().includes(query))
    : wsRows;
  const selectedWorkspace = workspaces.find(w => w.id === selectedWs) ?? null;

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

  const canSend = !!selectedWorkspace
    && selectedWorkspace.hidden !== 1
    && selectedAgent?.ready === true
    && !!message.trim()
    && !creating
    && !createUnknown;

  function submit() {
    if (!canSend || !executor) return;
    const payload = buildSessionCreatePayload({
      workspaceId: selectedWs,
      sessionName: '',
      executor,
      model: cliExecutor ? model : undefined,
      thinkingEffort: cliExecutor ? effort : undefined,
      approvalMode: cliExecutor ? mode : undefined,
    });
    writeJson(LAST_KEY, {
      workspaceId: selectedWs,
      executor,
      ...(payload.model ? { model: payload.model } : {}),
      ...(payload.thinkingEffort ? { thinkingEffort: payload.thinkingEffort } : {}),
      ...(payload.approvalMode ? { approvalMode: payload.approvalMode } : {}),
    });
    onCreate({ ...payload, firstMessage: message.trim() });
    // The text stays put on failure (the form stays open with the error);
    // CodingView unmounts this view once the create run confirms.
  }

  function startNewWorkspace() {
    wsDrop.setOpen(false);
    // Stash everything the return trip should restore, then flag the jump so
    // App re-opens this page once the sheet's create lands.
    writeJson(DRAFT_KEY, {
      message,
      ...(executor ? { executor } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { thinkingEffort: effort } : {}),
      ...(mode ? { approvalMode: mode } : {}),
    } satisfies NewSessionDraft);
    try { localStorage.setItem(RETURN_KEY, '1'); } catch { /* best-effort */ }
    onNewWorkspace();
  }

  function handleMessageKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
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
          {taskName !== undefined && (
            <div className="ns-task-static" data-testid="ns-task-name">{taskName}</div>
          )}
          {createError && (
            <p className="spaces-error" role="alert" data-testid="session-create-error">
              {createError}
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
                  onClick={() => { setSelectedWs(workspace.id); wsDrop.setOpen(false); }}
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
          <div className="composer-input-wrap">
            <textarea
              ref={taRef}
              className="composer-ta"
              data-testid="ns-message-input"
              rows={1}
              autoFocus
              value={message}
              onChange={event => setMessage(event.target.value)}
              onKeyDown={handleMessageKeyDown}
              placeholder={t('coding.new.message.placeholder')}
            />
          </div>
          <div className="composer-bar">
            {/* Capability chips follow the selected agent. claude/codex get
                live model + thinking drops; kimi's native options only exist
                on a live ACP session, so it shows its configured defaults. */}
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
            {executor === 'kimi' && (
              <>
                <span className="composer-opt ns-chip-static" data-testid="ns-model-chip">
                  <span className="name">{kimiDefaults?.model.trim() || t('coding.new.chip.default')}</span>
                </span>
                <span className="composer-opt ns-chip-static" data-testid="ns-effort-chip">
                  <BulbIcon />
                  <span className="name">{kimiDefaults?.thinking.trim() || t('coding.new.chip.default')}</span>
                </span>
              </>
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
            {executor === 'kimi' && (
              <span className="composer-opt ns-chip-static" data-testid="ns-mode-chip">
                <span className="name">{kimiDefaults?.mode.trim() || t('coding.new.chip.default')}</span>
              </span>
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
              {creating ? (
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
