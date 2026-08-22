/**
 * §10.3 Action gating primitives (`src/components/action-gating.ts`):
 * the Side Chat / Fork standard controls are always visible and enabled only
 * when BOTH the Catalog View (§9.4 descriptor with supported:true) and the
 * Session dynamic snapshot (§10.3 available_actions enabled:true) allow it.
 * No Provider-id/model/version heuristics — the module has no such inputs.
 */
import { describe, expect, it } from 'vitest';

import { actionControlState } from '../src/components/action-gating.js';
import type { CatalogActionDescriptor } from '../src/components/composer/capabilities.js';

const supported: CatalogActionDescriptor[] = [
  { id: 'sidechat.create', supported: true },
  { id: 'session.fork', supported: true },
  { id: 'session.fork.atTurn', supported: true },
];

describe('actionControlState (proposal §9.4/§10.3)', () => {
  it('is always visible, even with no catalog and no session actions', () => {
    expect(actionControlState(undefined, undefined, 'sidechat.create').visible).toBe(true);
    expect(actionControlState([], {}, 'session.fork').visible).toBe(true);
  });

  it('is disabled when the catalog has no descriptor for the action (missing ≡ supported:false)', () => {
    const state = actionControlState(
      [{ id: 'session.fork', supported: true }],
      { 'session.fork': { enabled: true }, 'sidechat.create': { enabled: true } },
      'sidechat.create',
    );
    expect(state.enabled).toBe(false);
    expect(state.reason).toBeUndefined();
  });

  it('is disabled when the catalog declares supported:false, surfacing the catalog reason', () => {
    const state = actionControlState(
      [{ id: 'session.fork', supported: false, reason: '当前 Runtime 不提供持久上下文分叉。' }],
      { 'session.fork': { enabled: true } },
      'session.fork',
    );
    expect(state).toEqual({
      visible: true,
      enabled: false,
      reason: '当前 Runtime 不提供持久上下文分叉。',
    });
  });

  it('is enabled only when the catalog supports AND the session enables the action', () => {
    const state = actionControlState(
      supported,
      { 'sidechat.create': { enabled: true } },
      'sidechat.create',
    );
    expect(state).toEqual({ visible: true, enabled: true });
  });

  it('is disabled when the session snapshot lacks the dynamic entry (temporarily unavailable)', () => {
    const state = actionControlState(supported, {}, 'sidechat.create');
    expect(state).toEqual({ visible: true, enabled: false });
  });

  it('prefers the session dynamic reason over the catalog reason', () => {
    const state = actionControlState(
      [{ id: 'session.fork', supported: true, reason: 'catalog reason' }],
      { 'session.fork': { enabled: false, reason: '当前没有可分叉的 Terminal Turn。' } },
      'session.fork',
    );
    expect(state.enabled).toBe(false);
    expect(state.reason).toBe('当前没有可分叉的 Terminal Turn。');
  });

  it('omits reason when neither layer provides one (caller uses the generic i18n fallback)', () => {
    const state = actionControlState(
      [{ id: 'session.fork', supported: false }],
      undefined,
      'session.fork',
    );
    expect(state).toEqual({ visible: true, enabled: false });
    expect('reason' in state).toBe(false);
  });

  it('session.fork.atTurn requires session.fork at BOTH layers (§7.2/§10.3)', () => {
    const bothEnabled = { 'session.fork': { enabled: true }, 'session.fork.atTurn': { enabled: true } };
    expect(actionControlState(supported, bothEnabled, 'session.fork.atTurn').enabled).toBe(true);

    // Dynamic layer: atTurn enabled but plain fork disabled → greyed.
    expect(actionControlState(supported, {
      'session.fork': { enabled: false },
      'session.fork.atTurn': { enabled: true },
    }, 'session.fork.atTurn').enabled).toBe(false);

    // Catalog layer: atTurn supported but plain fork unsupported → greyed.
    expect(actionControlState(
      [
        { id: 'session.fork', supported: false },
        { id: 'session.fork.atTurn', supported: true },
      ],
      bothEnabled,
      'session.fork.atTurn',
    ).enabled).toBe(false);
  });
});
