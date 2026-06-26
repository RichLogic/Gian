import { useEffect, useState } from 'react';
import type { Session, SystemConfig, Workspace } from '@gian/shared';
import { loadSessions, reorderWorkspaces, updateWorkspace } from '../api.js';
import { useT } from '../i18n/index.js';
import type { GianWs } from '../ws.js';
import { SpaceDetail, ClaudeMdInspector } from '../views/SpacesView.js';
import type { CreateWorktreeSessionInput } from '../views/SpacesView.js';

// Icon paths copied verbatim from design/gian-design-v2/js/data.jsx (`I`), so
// the Inspector list matches the prototype's WorkspacesInspector exactly.
const I = {
  plus: 'M12 5v14 M5 12h14',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  eyeOff: 'M2 12s4-7 10-7a9 9 0 0 1 4 1 M22 12s-4 7-10 7a9 9 0 0 1-4-1 M3 3l18 18 M9.9 9.9a3 3 0 0 0 4.2 4.2',
  arrowUp: 'M12 19V5 M5 12l7-7 7 7',
  arrowDown: 'M12 5v14 M19 12l-7 7-7-7',
};

function Icon({ d, size = 14, stroke = 1.6 }: { d: string; size?: number; stroke?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
         strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

// ─── Workspaces Inspector (right rail, zone 4) ───────────────────────────────
// Mirrors design/gian-design-v2/js/views.jsx → WorkspacesInspector: a flat list
// of workspaces with per-row eye(hide)/up/down buttons. NO leading icon, NO
// open-dot, NO session count. Clicking a row opens that workspace's detail as a
// Workbench tab (zone 3) via onOpenWorkspace.
//
// Unlike the prototype (where order + hidden are local-only and reset on
// reload), this is wired to the real persistence layer: reordering hits
// `POST /api/workspaces/reorder` and hide toggles `PATCH /api/workspaces/:id`
// { hidden }. The list itself reflects `workspace.sort_order` (already sorted by
// the host) and `workspace.hidden`.
export function WorkspacesInspector({
  workspaces,
  selectedWsId,
  openWsIds,
  onOpenWorkspace,
  onChange,
  onNewWorkspace,
}: {
  workspaces: Workspace[];
  /** The workspace whose detail tab is currently active in the Workbench. */
  selectedWsId: string | null;
  /** Ids of workspaces that currently have an open detail tab. */
  openWsIds: Set<string>;
  onOpenWorkspace: (wsId: string) => void;
  /** Re-fetch the workspace list after a reorder / hide toggle. */
  onChange: () => void;
  /** Surface the create-workspace flow (Spaces mode hosts the full form). */
  onNewWorkspace: () => void;
}) {
  const t = useT();

  async function move(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= workspaces.length) return;
    const ids = workspaces.map(w => w.id);
    const tmp = ids[idx]!;
    ids[idx] = ids[j]!;
    ids[j] = tmp;
    await reorderWorkspaces(ids);
    onChange();
  }

  async function toggleHidden(ws: Workspace) {
    await updateWorkspace(ws.id, { hidden: ws.hidden !== 1 });
    onChange();
  }

  return (
    <aside className="inspector">
      <div className="insp-head">
        <span className="label">{t('topbar.mode.workspaces')}</span>
        <button className="iconbtn" title={t('spaces.new')} onClick={onNewWorkspace}>
          <Icon d={I.plus} />
        </button>
      </div>
      <div className="insp-scroll">
        <div className="ws-list">
          {workspaces.map((w, idx) => {
            const open = openWsIds.has(w.id);
            const isHidden = w.hidden === 1;
            const active = w.id === selectedWsId && open;
            return (
              <div
                key={w.id}
                className={`ws-item ${active ? 'active' : ''} ${isHidden ? 'hidden' : ''}`}
                data-testid={`ws-item-${w.id}`}
              >
                <button className="ws-item-main" onClick={() => onOpenWorkspace(w.id)}>
                  <span className="ws-item-body">
                    <span className="ws-item-name">{w.name}</span>
                    <span className="ws-item-path mono">{w.path}</span>
                  </span>
                </button>
                <span className="ws-item-actions">
                  <button
                    className="ws-act"
                    title={isHidden ? t('spaces.kebab.show') : t('spaces.kebab.hide')}
                    aria-label={isHidden ? t('spaces.kebab.show') : t('spaces.kebab.hide')}
                    onClick={() => void toggleHidden(w)}
                  >
                    <Icon d={isHidden ? I.eyeOff : I.eye} size={14} />
                  </button>
                  <button
                    className="ws-act"
                    title={t('spaces.moveup.title')}
                    aria-label={t('spaces.moveup.title')}
                    disabled={idx === 0}
                    onClick={() => void move(idx, -1)}
                  >
                    <Icon d={I.arrowUp} size={14} />
                  </button>
                  <button
                    className="ws-act"
                    title={t('spaces.movedown.title')}
                    aria-label={t('spaces.movedown.title')}
                    disabled={idx === workspaces.length - 1}
                    onClick={() => void move(idx, 1)}
                  >
                    <Icon d={I.arrowDown} size={14} />
                  </button>
                </span>
              </div>
            );
          })}
          {workspaces.length === 0 && (
            <p className="spaces-empty">{t('spaces.empty')}</p>
          )}
        </div>
      </div>
    </aside>
  );
}

// ─── Workspace detail rendered inside a Workbench tab (zone 3) ────────────────
// Mirrors design/gian-design-v2/js/views.jsx → WorkspaceDetailBody, which reuses
// the existing Spaces detail bodies under a compact tab header. We reuse the real
// app's SpaceDetail (Overview / Git / Native panes + all their API wiring)
// verbatim — only the surrounding chrome differs (it lives in a Sheet tab, not
// the Spaces split view). CLAUDE.md editing surfaces as an inline drawer, same
// as in Spaces mode.
export function WorkspaceDetailBody({
  workspace,
  ws,
  systemConfig,
  onChange,
  onCreateWorktreeSession,
}: {
  workspace: Workspace | null;
  ws: GianWs;
  systemConfig: SystemConfig | null;
  onChange: () => void;
  onCreateWorktreeSession: (input: CreateWorktreeSessionInput) => void;
}) {
  void systemConfig;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [claudeMdOpen, setClaudeMdOpen] = useState(false);

  useEffect(() => {
    void loadSessions().then(setSessions);
  }, [workspace?.id]);

  // Drawer content belongs to the active workspace — close it when the tab's
  // workspace changes.
  useEffect(() => { setClaudeMdOpen(false); }, [workspace?.id]);

  return (
    <div className={`ws-detail-tab${claudeMdOpen ? ' has-inspector' : ''}`}>
      <SpaceDetail
        workspace={workspace}
        allSessions={sessions}
        ws={ws}
        onChange={onChange}
        onDeleted={onChange}
        onOpenClaudeMd={() => setClaudeMdOpen(true)}
        onCreateWorktreeSession={onCreateWorktreeSession}
      />
      {claudeMdOpen && workspace && (
        <ClaudeMdInspector
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          onClose={() => setClaudeMdOpen(false)}
        />
      )}
    </div>
  );
}
