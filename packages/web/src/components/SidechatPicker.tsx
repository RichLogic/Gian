import type { Session, Workspace } from '@gian/shared';
import { useT } from '../i18n/index.js';

export interface SidechatRow {
  session: Session;
  /** True when this session already has a chat surface mounted (a sidechat
   *  tab, or the main chat column) — tty claims are exclusive per session,
   *  so the row is shown but disabled. */
  disabled: boolean;
}

export interface SidechatGroup {
  wsId: string;
  wsName: string;
  rows: SidechatRow[];
}

/** Sessions the sidechat picker may offer, grouped by workspace in the
 *  sidebar's order (workspace sort_order, newest-updated session first;
 *  orphan workspace_ids appended at the end). Manager sessions are Tasks-mode
 *  internals and archived sessions are hidden — same rules as the sidebar. */
export function groupSidechatCandidates(
  sessions: Session[],
  workspaces: Workspace[],
  excludeIds: ReadonlySet<string>,
): SidechatGroup[] {
  const wsById = new Map(workspaces.map(w => [w.id, w]));
  const candidates = sessions.filter(s => s.archived === 0 && s.type !== 'manager');
  const byWs = new Map<string, SidechatRow[]>();
  for (const s of candidates) {
    const list = byWs.get(s.workspace_id) ?? [];
    list.push({ session: s, disabled: excludeIds.has(s.id) });
    byWs.set(s.workspace_id, list);
  }
  const orderedIds: string[] = [];
  const seen = new Set<string>();
  for (const w of workspaces) {
    if (byWs.has(w.id)) { orderedIds.push(w.id); seen.add(w.id); }
  }
  for (const wsId of byWs.keys()) {
    if (!seen.has(wsId)) orderedIds.push(wsId);
  }
  return orderedIds
    .map(wsId => ({
      wsId,
      wsName: wsById.get(wsId)?.name ?? wsId,
      rows: byWs.get(wsId)!.slice().sort((a, b) => Date.parse(b.session.updated_at) - Date.parse(a.session.updated_at)),
    }))
    .filter(g => g.rows.length > 0);
}

/** Inline session picker for the sidechat rail: rendered as the tab-strip
 *  "+" popover, and as panel 2's empty state when no chat tabs exist yet
 *  (`inline`). Sessions already open elsewhere are listed but disabled. */
export function SidechatPicker({
  sessions,
  workspaces,
  excludeIds,
  inline,
  onPick,
}: {
  sessions: Session[];
  workspaces: Workspace[];
  excludeIds: ReadonlySet<string>;
  inline?: boolean;
  onPick: (sessionId: string) => void;
}) {
  const t = useT();
  const groups = groupSidechatCandidates(sessions, workspaces, excludeIds);
  return (
    <div className={`sidechat-picker${inline ? ' inline' : ''}`} data-testid="sidechat-picker">
      <div className="sidechat-picker-head">{t('sidechat.pick')}</div>
      {groups.length === 0 && (
        <div className="sidechat-picker-empty">{t('sidechat.empty')}</div>
      )}
      {groups.map(g => (
        <div key={g.wsId} className="sidechat-picker-group">
          <div className="sidechat-picker-ws">{g.wsName}</div>
          {g.rows.map(({ session, disabled }) => (
            <button
              key={session.id}
              type="button"
              className={`sidechat-picker-row ${session.executor}`}
              disabled={disabled}
              title={disabled ? t('sidechat.alreadyOpen') : undefined}
              onClick={() => onPick(session.id)}
            >
              <span className="name">{session.name || `session ${session.id.slice(0, 6)}`}</span>
              <span className="exec">{session.executor}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
