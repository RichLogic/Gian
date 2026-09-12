import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from './render-app.js';
import { FIXTURE_SCENARIOS, sampleInteraction } from '../src/scenarios.js';

describe('interaction cards (B7)', () => {
  it('renders a pending approval via @gian/chat-ui with the Host-given actions', () => {
    renderApp({ scenario: FIXTURE_SCENARIOS['interaction-pending'], viewport: 'wide' });
    expect(screen.getAllByText('git config core.hooksPath .husky').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
  });

  it('respond returns only the opaque action id + values', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: FIXTURE_SCENARIOS['interaction-pending'], viewport: 'wide' });
    await user.click(screen.getByRole('button', { name: 'Allow once' }));
    const mutation = Object.values(controller.state.mutations).find((m) => m.label === 'interaction.respond');
    expect(mutation?.phase).toBe('pending');
    expect(controller.state.interactionPhases['int-1']).toBe('responding');
    controller.test.resolveAll();
    expect(controller.state.interactionPhases['int-1']).toBe('resolved-here');
  });

  it('crafted callback guard: unknown action ids and double-respond are refused', () => {
    const { controller } = renderApp({ scenario: FIXTURE_SCENARIOS['interaction-pending'], viewport: 'wide' });
    controller.actions.respondToInteraction('int-1', 'act-not-offered');
    expect(controller.test.pendingCommandIds()).toHaveLength(0);
    controller.actions.respondToInteraction('int-1', 'act-allow');
    expect(controller.test.pendingCommandIds()).toHaveLength(1);
    // second respond while responding is refused
    controller.actions.respondToInteraction('int-1', 'act-decline');
    expect(controller.test.pendingCommandIds()).toHaveLength(1);
  });

  it('question interactions render inputs (multi-select) from the wire shape', () => {
    renderApp({ scenario: FIXTURE_SCENARIOS['interaction-question'], viewport: 'narrow' });
    expect(screen.getByText('这次改动要覆盖哪些位置？')).toBeInTheDocument();
    expect(screen.getByText('.husky/pre-push')).toBeInTheDocument();
    expect(screen.getByText('CONTRIBUTING.md')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument();
  });

  it('resolved on another device renders a compressed line', () => {
    const { controller } = renderApp({ scenario: FIXTURE_SCENARIOS['interaction-pending'], viewport: 'wide' });
    controller.test.resolveInteractionElsewhere('int-1');
    expect(screen.getByText(/已在其他设备处理/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
  });

  it('expired interaction renders its terminal line', () => {
    const { controller } = renderApp({ scenario: FIXTURE_SCENARIOS['interaction-pending'], viewport: 'wide' });
    controller.test.expireInteraction('int-1');
    expect(screen.getByText(/已过期/)).toBeInTheDocument();
  });

  it('offline refuses interaction responses (crafted call)', () => {
    const scenario = {
      ...FIXTURE_SCENARIOS['interaction-pending']!,
      connection: { kind: 'host_offline', lastSeenAt: Date.now() } as const,
    };
    const { controller } = renderApp({ scenario, viewport: 'wide' });
    controller.actions.respondToInteraction('int-1', 'act-allow');
    expect(controller.test.pendingCommandIds()).toHaveLength(0);
  });

  it('exit_plan_mode and native_choice kinds project to cards', () => {
    const scenario = {
      hostData: {
        'host-home': {
          sessions: FIXTURE_SCENARIOS['interaction-pending']!.hostData!['host-home']!.sessions,
          interactions: [
            sampleInteraction({ id: 'int-plan', kind: 'exit_plan_mode' }),
            sampleInteraction({ id: 'int-native', kind: 'native_choice' }),
          ],
        },
      },
    };
    renderApp({ scenario, viewport: 'wide' });
    expect(document.querySelectorAll('.ap2').length).toBeGreaterThanOrEqual(2);
  });
});
