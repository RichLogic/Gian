/**
 * Conversation rail (B3, §12.1.2): the local Tasks/Repos hierarchy, reduced
 * to Remote-authorized actions. Only incomplete Sessions owned by open Tasks
 * are present under Doing. Task headers only expand and create Sessions; there
 * is no task menu, pin, complete, archive, or Unassigned surface. Narrow
 * layouts use a full page, not a drawer.
 */

import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { RemoteSession, RemoteTask } from '@gian/remote-protocol';
import { useT } from '../i18n/index.js';
import { useRemoteActions, useRemoteState } from './controller-context.js';
import { Icon } from './icons.js';
import { ProxyLogo } from './proxy-logo.js';
import { RemoteStatusIcon, remoteStatusGlyphShown } from './session-status.js';
import { useViewportMode } from './viewport.js';

function sessionStatusKey(session: RemoteSession, stale: boolean): string {
  if (stale) return 'session.status.stale';
  switch (session.status) {
    case 'running': return 'session.status.running';
    case 'pending': return 'session.status.pending';
    case 'error': return 'session.status.error';
    default: return 'session.status.done';
  }
}

function SessionRow({ session, stale }: { session: RemoteSession; stale: boolean }) {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const mode = useViewportMode();
  const active = state.view.kind === 'chat' && state.view.sessionId === session.id;
  const running = !stale && session.status === 'running';
  const unread = session.unread === true;
  const showStatus = remoteStatusGlyphShown(session.status, unread, stale);
  return (
    <div
      className={`rail-item session-row${active ? ' active' : ''}${running ? ' is-running' : ''}${showStatus ? ' has-status' : ''}`}
      role="button"
      tabIndex={0}
      aria-current={active ? 'page' : undefined}
      aria-label={`${session.name ?? session.id} — ${t(sessionStatusKey(session, stale))}`}
      onClick={() => {
        actions.selectSession(session.id);
        if (mode === 'narrow') actions.openMobilePage('chat');
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          actions.selectSession(session.id);
          if (mode === 'narrow') actions.openMobilePage('chat');
        }
      }}
    >
      <div className="ri-body">
        <div className="ri-row1">
          <ProxyLogo proxy={session.agent.proxy} name={session.agent.name} size={14} />
          <span className="ri-title">{session.name ?? session.id}</span>
          {showStatus && <RemoteStatusIcon status={session.status} unread={unread} />}
        </div>
      </div>
    </div>
  );
}

const RAIL_SECTIONS_KEY = 'gian.remote.rail.sections.collapsed';
const RAIL_TASKS_KEY = 'gian.remote.rail.tasks.collapsed';

function storedSet(key: string): Set<string> {
  try {
    const value = localStorage.getItem(key);
    return new Set<string>(value ? JSON.parse(value) as string[] : []);
  } catch {
    return new Set();
  }
}

function RailSection({
  label,
  collapsed,
  onToggle,
  onAdd,
  addTitle,
  testId,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  addTitle?: string;
  testId: string;
}) {
  return (
    <div
      className="sb-section"
      role="button"
      tabIndex={0}
      aria-expanded={!collapsed}
      data-testid={testId}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggle();
        }
      }}
    >
      <span className="sb-caret">
        <Icon name={collapsed ? 'caret-right' : 'caret-down'} size={12} />
      </span>
      <span className="sb-section-label">{label}</span>
      {onAdd && (
        <span className="sb-section-acts">
          <button
            type="button"
            className="sb-act"
            aria-label={addTitle}
            title={addTitle}
            onClick={(event) => {
              event.stopPropagation();
              onAdd();
            }}
          >
            <Icon name="plus" size={13} />
          </button>
        </span>
      )}
    </div>
  );
}

function TaskGroup({
  task,
  sessions,
  stale,
  collapsed,
  onToggle,
}: {
  task: RemoteTask;
  sessions: RemoteSession[];
  stale: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const actions = useRemoteActions();
  const mode = useViewportMode();
  return (
    <div className="tasks-list-task">
      <div
        className={`sb-group task-group${collapsed ? '' : ' open'}`}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle();
          }
        }}
      >
        <span className="sb-group-ico">
          <Icon name={collapsed ? 'caret-right' : 'caret-down'} size={12} />
        </span>
        <span className="task-group-name">{task.name}</span>
        <span className="sb-group-acts">
          <button
            type="button"
            className="sb-act"
            title={t('rail.newChatForTask')}
            aria-label={t('rail.newChatForTask')}
            onClick={(event) => {
              event.stopPropagation();
              actions.openNewChat(task.id);
              if (mode === 'narrow') actions.openMobilePage('new-chat');
            }}
          >
            <Icon name="plus" size={13} />
          </button>
        </span>
      </div>
      {!collapsed && sessions.map((session) => (
        <SessionRow key={session.id} session={session} stale={stale} />
      ))}
    </div>
  );
}

export function RailBody() {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const mode = useViewportMode();
  const stale = state.connection.kind !== 'online';
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    () => storedSet(RAIL_SECTIONS_KEY),
  );
  const [collapsedTasks, setCollapsedTasks] = useState<Set<string>>(
    () => storedSet(RAIL_TASKS_KEY),
  );

  const toggleStored = (
    key: string,
    storageKey: string,
    setter: Dispatch<SetStateAction<Set<string>>>,
  ) => {
    setter((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };

  const openTasks = state.tasks;
  const sessionsByTask = new Map<string, RemoteSession[]>();
  for (const session of state.sessions) {
    if (!session.task_id) continue;
    const list = sessionsByTask.get(session.task_id) ?? [];
    list.push(session);
    sessionsByTask.set(session.task_id, list);
  }

  return (
    <>
      <div className="sb-scroll">
        <div className="sb-toprow rw-rail-heading">
          <span className="rw-rail-title">{t('rail.tasks')}</span>
        </div>
        <RailSection
          label={t('rail.doing')}
          collapsed={collapsedSections.has('doing')}
          onToggle={() => toggleStored('doing', RAIL_SECTIONS_KEY, setCollapsedSections)}
          testId="remote-section-doing"
        />
        {!collapsedSections.has('doing') && openTasks.map((task) => (
          <TaskGroup
            key={task.id}
            task={task}
            sessions={sessionsByTask.get(task.id) ?? []}
            stale={stale}
            collapsed={collapsedTasks.has(task.id)}
            onToggle={() => toggleStored(task.id, RAIL_TASKS_KEY, setCollapsedTasks)}
          />
        ))}
      </div>
      <div className="rw-sb-foot">
        <button
          type="button"
          className={`sb-iconbtn${state.view.kind === 'settings' ? ' active' : ''}`}
          title={t('rail.settings')}
          aria-label={t('rail.settings')}
          onClick={() => {
            actions.openSettings();
            if (mode === 'narrow') actions.openMobilePage('settings');
          }}
        >
          <Icon name="settings" size={15} />
        </button>
        <span className="rw-sb-foot-label">{t('rail.settings')}</span>
      </div>
    </>
  );
}

/** Desktop sidebar wrapper. */
export function Rail() {
  const t = useT();
  return (
    <aside className="sidebar" aria-label={t('rail.title')}>
      <RailBody />
    </aside>
  );
}

/** Narrow full-screen rail page (mockup F4) — a real page, not a drawer. */
export function RailPage() {
  const t = useT();
  const actions = useRemoteActions();
  return (
    <div className="rw-page" data-page="rail">
      <div className="rw-page-head">
        <button
          type="button"
          className="sb-iconbtn"
          title={t('shell.back')}
          aria-label={t('shell.back')}
          onClick={() => actions.openMobilePage('chat')}
        >
          <Icon name="back" size={15} />
        </button>
        <span className="rw-page-title">{t('rail.title')}</span>
        <span className="sb-toprow-spacer" />
      </div>
      <RailBody />
    </div>
  );
}
