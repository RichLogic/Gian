// P3a-1. Remote interaction resource identity. NOT_RUN.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { RespondInteractionParams } from '../src/proxy/types.js';
import { remoteActionId, remoteInteractionResourceId, remoteStableUuid } from '../src/remote/projection.js';
import { MemoryRemoteIdentity } from '../src/remote/identity.js';
import { RemoteRuntime } from '../src/remote/runtime.js';
import { command, HARNESS_AGENT, seedDevice, setupRemoteHarness, teardownRemoteHarness } from './fixtures/remote-harness.js';

const NATIVE = '11111111-1111-4111-8111-111111111111';

test('same provider interaction id cannot route a stale remote card onto the other session', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const create = async () => {
      const created = await context.runtime.commands.execute(device, command('session.create', {
        catalog_revision: context.runtime.projector.catalogRevision(),
        workspace_id: context.workspaceId,
        task_id: context.taskId,
        agent_id: remoteStableUuid('agent', 'agent-claude-review'),
      }));
      assert.equal(created.ok, true, created.error?.message);
      return (created.data as { id: string }).id;
    };
    const sessionA = await create();
    const sessionB = await create();
    void context.approvals.request({
      sessionId: sessionA,
      turnId: 'turn-a',
      category: 'command',
      risk: 'high',
      description: 'from a',
      payload: { approvalId: NATIVE },
    });
    void context.approvals.request({
      sessionId: sessionB,
      turnId: 'turn-b',
      category: 'command',
      risk: 'high',
      description: 'from b',
      payload: { approvalId: NATIVE },
    });

    const snapshot = await context.runtime.commands.execute(device, command('state.refresh', {}));
    assert.equal(snapshot.ok, true, snapshot.error?.message);
    const interactions = (snapshot.data as {
      interactions: Array<{ id: string; session_id: string; presentation: { actions: Array<{ id: string }> } }>;
    }).interactions;
    const cardA = interactions.find(item => item.session_id === sessionA);
    const cardB = interactions.find(item => item.session_id === sessionB);
    assert.ok(cardA);
    assert.ok(cardB);
    assert.equal(interactions.length, 2);
    assert.notEqual(cardA.id, cardB.id);
    assert.notEqual(cardA.id, NATIVE);
    assert.notEqual(cardB.id, NATIVE);
    assert.equal(cardA.id, remoteInteractionResourceId(sessionA, 'turn-a', NATIVE));
    assert.equal(cardB.id, remoteInteractionResourceId(sessionB, 'turn-b', NATIVE));
    const actionA = remoteActionId(cardA.id, 'allow_once');
    const actionB = remoteActionId(cardB.id, 'allow_once');
    assert.notEqual(actionA, actionB);
    assert.equal(cardA.presentation.actions.some(action => action.id === actionA), true);
    assert.equal(cardB.presentation.actions.some(action => action.id === actionB), true);

    const seen: RespondInteractionParams[] = [];
    context.proxy.client.respondInteraction = async (params) => { seen.push(params); };
    const beforeSequence = context.runtime.replay.eventSequence;
    const beforeRevision = context.runtime.replay.currentRevision;
    context.approvals.resolve(NATIVE, 'decline', 'web', sessionA);
    const frames = context.runtime.replay.replayAfter(beforeSequence - 1, beforeRevision);
    assert.notEqual(frames, 'snapshot');
    if (frames === 'snapshot') return;
    const removeIds = frames.flatMap(frame => (
      frame.message.type === 'state.patch' ? frame.message.patch.interactions?.remove_ids ?? [] : []
    ));
    assert.equal(removeIds.includes(cardA.id), true);
    assert.equal(removeIds.includes(cardB.id), false);

    const after = await context.runtime.commands.execute(device, command('state.refresh', {}));
    const left = (after.data as { interactions: Array<{ id: string; session_id: string }> }).interactions;
    assert.deepEqual(left.map(item => item.id), [cardB.id]);

    const lateNative = await context.runtime.commands.execute(device, command('interaction.respond', {
      interaction_id: NATIVE,
      interaction_revision: '0',
      action_id: actionB,
    }));
    const lateCard = await context.runtime.commands.execute(device, command('interaction.respond', {
      interaction_id: cardA.id,
      interaction_revision: '0',
      action_id: actionA,
    }));
    assert.equal(lateNative.ok, false);
    assert.equal(lateNative.error?.code, 'PRECONDITION_FAILED');
    assert.equal(lateCard.ok, false);
    assert.equal(lateCard.error?.code, 'PRECONDITION_FAILED');
    assert.equal(seen.length, 0);
    assert.equal(context.approvals.getPending(NATIVE, sessionA), undefined);
    assert.equal(context.approvals.getPending(NATIVE, sessionB)?.sessionId, sessionB);

    const respondB = await context.runtime.commands.execute(device, command('interaction.respond', {
      interaction_id: cardB.id,
      interaction_revision: '0',
      action_id: actionB,
    }));
    assert.equal(respondB.ok, true, respondB.error?.message);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.interactionId, NATIVE);
    assert.equal(context.approvals.getPending(NATIVE, sessionB)?.id, NATIVE);
  } finally {
    teardownRemoteHarness(context);
  }
});

test('a stale card from an ended turn cannot act on a new pending occurrence with the same provider id', async () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const created = await context.runtime.commands.execute(device, command('session.create', {
      catalog_revision: context.runtime.projector.catalogRevision(),
      workspace_id: context.workspaceId,
      task_id: context.taskId,
      agent_id: remoteStableUuid('agent', 'agent-claude-review'),
    }));
    assert.equal(created.ok, true, created.error?.message);
    const sessionId = (created.data as { id: string }).id;
    void context.approvals.request({
      sessionId,
      turnId: 'turn-1',
      category: 'command',
      risk: 'high',
      description: 'first occurrence',
      payload: { approvalId: NATIVE },
    });
    const first = await context.runtime.commands.execute(device, command('state.refresh', {}));
    const firstCards = (first.data as {
      interactions: Array<{ id: string; revision: string; presentation: { actions: Array<{ id: string }> } }>;
    }).interactions;
    assert.equal(firstCards.length, 1);
    const staleCard = firstCards[0]!;
    const staleAction = remoteActionId(staleCard.id, 'allow_once');
    assert.equal(staleCard.id, remoteInteractionResourceId(sessionId, 'turn-1', NATIVE));
    assert.equal(staleCard.revision, '0');

    // Turn 1 ends without an answer; the next Host turn reuses the provider id.
    context.approvals.releaseHostTurn(sessionId, 'turn-1');
    void context.approvals.request({
      sessionId,
      turnId: 'turn-2',
      category: 'command',
      risk: 'high',
      description: 'second occurrence',
      payload: { approvalId: NATIVE },
    });
    const second = await context.runtime.commands.execute(device, command('state.refresh', {}));
    const secondCards = (second.data as {
      interactions: Array<{ id: string; revision: string; presentation: { actions: Array<{ id: string }> } }>;
    }).interactions;
    assert.equal(secondCards.length, 1);
    const liveCard = secondCards[0]!;
    const liveAction = remoteActionId(liveCard.id, 'allow_once');
    assert.notEqual(staleCard.id, liveCard.id);
    assert.equal(liveCard.id, remoteInteractionResourceId(sessionId, 'turn-2', NATIVE));
    // Both occurrences sit at revision 0; only the turn-bound identity separates them.
    assert.equal(liveCard.revision, '0');

    const seen: RespondInteractionParams[] = [];
    context.proxy.client.respondInteraction = async (params) => { seen.push(params); };
    const stale = await context.runtime.commands.execute(device, command('interaction.respond', {
      interaction_id: staleCard.id,
      interaction_revision: '0',
      action_id: staleAction,
    }));
    assert.equal(stale.ok, false);
    assert.equal(stale.error?.code, 'PRECONDITION_FAILED');
    assert.equal(seen.length, 0);
    assert.equal(context.approvals.getPending(NATIVE, sessionId)?.turnId, 'turn-2');

    const live = await context.runtime.commands.execute(device, command('interaction.respond', {
      interaction_id: liveCard.id,
      interaction_revision: '0',
      action_id: liveAction,
    }));
    assert.equal(live.ok, true, live.error?.message);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.interactionId, NATIVE);
    const stored = context.db.prepare(
      'SELECT turn_id, response_id FROM proxy_interactions WHERE session_id = ? AND interaction_id = ?',
    ).get(sessionId, NATIVE) as { turn_id: string; response_id: string };
    assert.equal(stored.turn_id, 'turn-2');
    assert.equal(stored.response_id, seen[0]?.responseId);
  } finally {
    teardownRemoteHarness(context);
  }
});

test('a card first delivered by snapshot is removed exactly on terminal and resolve', async () => {
  const context = setupRemoteHarness();
  let late: RemoteRuntime | undefined;
  try {
    const device = seedDevice(context);
    const create = async () => {
      const created = await context.runtime.commands.execute(device, command('session.create', {
        catalog_revision: context.runtime.projector.catalogRevision(),
        workspace_id: context.workspaceId,
        task_id: context.taskId,
        agent_id: remoteStableUuid('agent', 'agent-claude-review'),
      }));
      assert.equal(created.ok, true, created.error?.message);
      return (created.data as { id: string }).id;
    };
    const sessionA = await create();
    const sessionB = await create();
    void context.approvals.request({
      sessionId: sessionA,
      turnId: 'turn-sa',
      category: 'command',
      risk: 'high',
      description: 'snapshot card a',
      payload: { approvalId: NATIVE },
    });
    void context.approvals.request({
      sessionId: sessionB,
      turnId: 'turn-sb',
      category: 'command',
      risk: 'high',
      description: 'snapshot card b',
      payload: { approvalId: NATIVE },
    });

    // A runtime that never observed the live approval:created broadcasts;
    // it meets both pendings for the first time through the snapshot.
    late = new RemoteRuntime({
      db: context.db,
      sessions: context.sessions,
      tasks: context.tasks,
      access: context.access,
      tool: context.tool,
      identity: new MemoryRemoteIdentity(),
      dataDir: context.dir,
      hostVersion: '0.0.0-test',
      listAgents: () => [HARNESS_AGENT],
      hostEvents: context.broadcaster,
    });
    const snapshot = await late.commands.execute(device, command('state.refresh', {}));
    assert.equal(snapshot.ok, true, snapshot.error?.message);
    const cards = (snapshot.data as {
      interactions: Array<{ id: string; session_id: string; presentation: { actions: Array<{ id: string }> } }>;
    }).interactions;
    const cardA = cards.find(item => item.session_id === sessionA);
    const cardB = cards.find(item => item.session_id === sessionB);
    assert.ok(cardA);
    assert.ok(cardB);
    assert.equal(cardA.id, remoteInteractionResourceId(sessionA, 'turn-sa', NATIVE));
    assert.equal(cardB.id, remoteInteractionResourceId(sessionB, 'turn-sb', NATIVE));

    // Host turn terminal removes exactly the snapshot-issued card. This
    // runtime's replay buffer is still empty — its first live frames are the
    // removal itself — so there is no earlier frame revision to anchor the
    // chain check on; read the revision at replay time instead.
    const terminalSequence = late.replay.eventSequence;
    context.approvals.releaseHostTurn(sessionA, 'turn-sa');
    const terminalFrames = late.replay.replayAfter(terminalSequence - 1, late.replay.currentRevision);
    assert.notEqual(terminalFrames, 'snapshot');
    if (terminalFrames === 'snapshot') return;
    const terminalRemovals = terminalFrames.flatMap(frame => (
      frame.message.type === 'state.patch' ? frame.message.patch.interactions?.remove_ids ?? [] : []
    ));
    assert.equal(terminalRemovals.includes(cardA.id), true);
    assert.equal(terminalRemovals.includes(cardB.id), false);

    // A new occurrence in the same session is a different card; resolving it
    // removes exactly that card and leaves the other session alone.
    void context.approvals.request({
      sessionId: sessionA,
      turnId: 'turn-sa2',
      category: 'command',
      risk: 'high',
      description: 'snapshot card a2',
      payload: { approvalId: NATIVE },
    });
    const second = await late.commands.execute(device, command('state.refresh', {}));
    const secondCards = (second.data as {
      interactions: Array<{ id: string; session_id: string }>;
    }).interactions;
    const cardA2 = secondCards.find(item => item.session_id === sessionA);
    assert.ok(cardA2);
    assert.notEqual(cardA2.id, cardA.id);
    const resolveSequence = late.replay.eventSequence;
    const resolveRevision = late.replay.currentRevision;
    context.approvals.resolve(NATIVE, 'decline', 'web', sessionA);
    const resolveFrames = late.replay.replayAfter(resolveSequence - 1, resolveRevision);
    assert.notEqual(resolveFrames, 'snapshot');
    if (resolveFrames === 'snapshot') return;
    const resolveRemovals = resolveFrames.flatMap(frame => (
      frame.message.type === 'state.patch' ? frame.message.patch.interactions?.remove_ids ?? [] : []
    ));
    assert.equal(resolveRemovals.includes(cardA2.id), true);
    assert.equal(resolveRemovals.includes(cardA.id), false);
    assert.equal(resolveRemovals.includes(cardB.id), false);

    const respondB = await late.commands.execute(device, command('interaction.respond', {
      interaction_id: cardB.id,
      interaction_revision: '0',
      action_id: remoteActionId(cardB.id, 'allow_once'),
    }));
    assert.equal(respondB.ok, true, respondB.error?.message);
  } finally {
    late?.close();
    teardownRemoteHarness(context);
  }
});
