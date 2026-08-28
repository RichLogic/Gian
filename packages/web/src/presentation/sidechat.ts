/**
 * Side Chat presentation helpers (gian.proxy/2.0 proposal §10.5,
 * `docs/proposals/gian-proxy-v2-ui-bridge.md`).
 *
 * A Side Chat is a TEMPORARY side conversation bound to a parent Session —
 * never a normal Gian Session: it must not appear in session lists, search,
 * archive, history, trace, or native-session UIs (§10.5.2). Everything here
 * is pure so the surface (`components/SideChatDock.tsx`) and the topbar
 * cascade stay testable without mounting the app.
 *
 * `SideChatInfo` deliberately carries no `resumeRef` and no stream id
 * (§10.5.1: the provider-owned resume reference is never user-visible). None
 * of these helpers may reintroduce it into rendered output or wire messages.
 */
import {
  isApprovalMode,
  type ConfigValue,
  type Executor,
  type Session,
  type SideChatInfo,
} from '@gian/shared';

/** Records bound to one parent Session, oldest first (chip/tab order). */
export function sideChatsForParent(
  sideChats: readonly SideChatInfo[],
  parentSessionId: string,
): SideChatInfo[] {
  return sideChats
    .filter(entry => entry.parent_session_id === parentSessionId)
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/**
 * Display label for a Side Chat chip/tab. The Host-owned creation ordinal
 * gives an unnamed record its stable `ChatN` label; the first completed Agent
 * conversation can replace it with a persisted name. The SAME label is used
 * by the parent-close cascade so the confirm names what the user sees.
 */
export function sideChatLabel(
  t: (key: string) => string,
  sideChat: SideChatInfo,
  index: number,
): string {
  void t;
  return sideChat.name || `Chat${sideChat.ordinal ?? index + 1}`;
}

/**
 * The four mandated close-confirm clauses (§10.5.4, §15): permanent local
 * deletion, running-turn stop, NO rollback of external side effects, and the
 * provider-records caveat. The provider clause is unconditional — Gian only
 * learns `providerDataDeleted` AFTER the close succeeds, so the confirm must
 * never claim provider-side deletion up front.
 */
export function sideChatCloseConfirmMessage(t: (key: string) => string): string {
  return [
    t('sidechat.closeConfirm.deleted'),
    t('sidechat.closeConfirm.turnStopped'),
    t('sidechat.closeConfirm.sideEffects'),
    t('sidechat.closeConfirm.providerRecords'),
  ].join('\n');
}

/**
 * Cascade suffix for the PARENT session delete confirm (§10.5.4: explicitly
 * closing a parent session permanently closes its still-open Side Chats —
 * the confirm must list them). Empty string when the parent has none.
 */
export function sideChatParentCascadeSuffix(
  t: (key: string) => string,
  openSideChats: readonly SideChatInfo[],
): string {
  if (openSideChats.length === 0) return '';
  const names = openSideChats
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((entry, index) => sideChatLabel(t, entry, index))
    .join(', ');
  return ` ${t('sidechat.parentCloseCascade').replace('{names}', names)}`;
}

/**
 * Minimal `Session` adapter for the shared `Composer`. Session-bound config
 * stays inherited from the parent, while the Side Chat's Host-owned
 * `turn_config` draft drives the independently mutable next-turn controls.
 *
 * - `id` is the Side Chat id, so per-conversation composer drafts and the
 *   `session.stop`/`message.send` entity keys stay isolated per Side Chat.
 * - The composer runs in `variant="sidechat"`: only Proxy-advertised
 *   Turn-bound controls are interactive. Their mutations are Gian Host state,
 *   never ordinary Session methods and never `catalog.resolve(sidechatId)`.
 * - `status` is inert: the dock drives the composer from the Side Chat's own
 *   pending/recovering/closing state, never from this field.
 */
export function sideChatComposerSession(sideChat: SideChatInfo, parent: Session): Session {
  const options = sideChat.turn_config_options ?? [];
  const turnConfig = sideChat.turn_config ?? parent.turn_config ?? {};
  const valueForRole = (role: string): ConfigValue | undefined => {
    const option = options.find(entry => entry.binding === 'turn' && entry.role === role);
    if (!option) return undefined;
    return Object.prototype.hasOwnProperty.call(turnConfig, option.id)
      ? turnConfig[option.id]
      : option.defaultValue;
  };
  const model = valueForRole('model');
  const effort = valueForRole('effort');
  const approval = valueForRole('approval_mode');
  const fast = valueForRole('fast');
  return {
    ...parent,
    id: sideChat.id,
    name: null,
    status: 'done',
    unread: 0,
    completed_at: null,
    worktree_outcome: null,
    created_at: sideChat.created_at,
    updated_at: sideChat.updated_at,
    model: model === undefined ? parent.model : model == null ? null : String(model),
    thinking_effort: effort === undefined
      ? parent.thinking_effort
      : effort == null ? null : String(effort),
    approval_mode: isApprovalMode(approval) ? approval : parent.approval_mode,
    service_tier: fast === undefined ? parent.service_tier : fast === true ? 'fast' : null,
    turn_config: turnConfig,
    turn_config_options: options,
    turn_config_revision: sideChat.turn_config_revision ?? null,
  };
}

/**
 * Executor used to apply a Side Chat's event envelopes to its transcript:
 * always the PARENT session's executor (the Side Chat route runs the same
 * runtime; §10.5.1 inherits sessionConfig). Falls back to 'claude' when the
 * parent is momentarily unknown (e.g. an event racing the session list),
 * matching the existing session-event fallback in use-app-socket.
 */
export function sideChatExecutor(parent: Session | null | undefined): Executor {
  return parent?.executor ?? 'claude';
}
