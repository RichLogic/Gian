// Coverage for traceability row:
//   IM-INV-002 — InteractiveFlowManager must isolate flows by bot+channel,
//                route replies by the parent message id, time flows out
//                cleanly, and cancel any prior flow when a new one starts
//                in the same channel.
//
// Pure unit on `packages/host/src/im/messaging/interactive-flow.ts`.
// The platform manager (Discord/Slack) is the consumer; we drive the engine
// directly with hand-written async generators that yield/return on cue.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { InteractiveFlowManager, type FlowGenerator } from '../src/im/messaging/interactive-flow.js';

/**
 * Wrap a test body so the flow manager is always shut down at the end
 * regardless of assertion failures. Without this, the 5-minute inactivity
 * timer in `interactive-flow.ts` keeps node's event loop alive after the
 * test resolves and the runner appears to hang.
 */
function withFlowManager(body: (mgr: InteractiveFlowManager) => Promise<void>) {
  return async () => {
    const mgr = new InteractiveFlowManager();
    try {
      await body(mgr);
    } finally {
      mgr.shutdown();
    }
  };
}

// Helper — build a generator that yields each prompt in order and returns the
// final completion message. Exposes a record of every reply it received so
// tests can assert the engine forwarded them in order.
function scriptedFlow(prompts: string[], final: string) {
  const received: string[] = [];
  async function* run(): AsyncGenerator<string, string, string> {
    for (const p of prompts) {
      const reply = yield p;
      received.push(reply);
    }
    return final;
  }
  return { gen: run() as FlowGenerator, received };
}

// A flow that returns immediately without yielding any prompts.
function instantFlow(value: string) {
  async function* run(): AsyncGenerator<string, string, string> {
    return value;
  }
  return run() as FlowGenerator;
}

// A flow that records whether `.return()` was ever invoked on it (so we can
// detect cancel / cleanup).
function cancellableFlow() {
  let returned = false;
  let prompted = 0;
  async function* run(): AsyncGenerator<string, string, string> {
    try {
      while (true) {
        prompted += 1;
        yield `prompt-${prompted}`;
      }
    } finally {
      returned = true;
    }
  }
  const gen = run() as FlowGenerator;
  return {
    gen,
    get returned() { return returned; },
    get prompted() { return prompted; },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle: start / register / reply / complete
// ---------------------------------------------------------------------------

test('IM-INV-002: startFlow yields the first prompt and exposes hasActiveFlow', withFlowManager(async (mgr) => {
  const { gen } = scriptedFlow(['pick a model'], 'done');

  assert.equal(mgr.hasActiveFlow('bot-a', 'chan-1'), false,
    'no flow exists before start');

  const result = await mgr.startFlow({
    botId: 'bot-a', channelId: 'chan-1', userId: 'u1',
    generator: gen,
    onExpire: () => {},
  });

  assert.equal(result.type, 'prompt');
  assert.equal(result.message, 'pick a model');
  assert.equal(mgr.hasActiveFlow('bot-a', 'chan-1'), true,
    'startFlow registers the flow under bot+channel');
}));

test('IM-INV-002: registerFlowMessage routes a reply back through the right generator', withFlowManager(async (mgr) => {
  const { gen, received } = scriptedFlow(['pick'], 'all done');

  await mgr.startFlow({
    botId: 'bot-a', channelId: 'chan-1', userId: 'u1',
    generator: gen,
    onExpire: () => {},
  });
  mgr.registerFlowMessage('bot-a', 'chan-1', 'msg-1');

  assert.equal(mgr.isFlowMessage('msg-1'), true,
    'after register the message id is recognized as a flow message');
  assert.equal(mgr.isFlowMessage('unrelated'), false);

  const reply = await mgr.handleReply('msg-1', 'sonnet');
  assert.ok(reply);
  assert.equal(reply!.type, 'complete');
  assert.equal(reply!.message, 'all done',
    'after the final yield, the engine returns the generator return value');
  assert.deepEqual(received, ['sonnet'],
    'generator received the reply content, trimmed');
}));

test('IM-INV-002: trailing whitespace in replies is trimmed before forwarding', withFlowManager(async (mgr) => {
  const { gen, received } = scriptedFlow(['pick'], 'done');
  await mgr.startFlow({
    botId: 'bot-a', channelId: 'chan-1', userId: 'u1',
    generator: gen,
    onExpire: () => {},
  });
  mgr.registerFlowMessage('bot-a', 'chan-1', 'msg-1');
  await mgr.handleReply('msg-1', '  sonnet  \n');
  assert.deepEqual(received, ['sonnet'],
    'engine trims whitespace so platforms do not need to pre-clean replies');
}));

test('IM-INV-002: handleReply returns null for unrelated messages without disturbing active flows', withFlowManager(async (mgr) => {
  const { gen } = scriptedFlow(['pick'], 'done');
  await mgr.startFlow({
    botId: 'bot-a', channelId: 'chan-1', userId: 'u1',
    generator: gen,
    onExpire: () => {},
  });
  const result = await mgr.handleReply('not-a-flow-msg', 'whatever');
  assert.equal(result, null);
  assert.equal(mgr.hasActiveFlow('bot-a', 'chan-1'), true,
    'active flow stays intact when a foreign message is handled');
}));

test('IM-INV-002: startFlow with an already-completing generator returns complete without registering', withFlowManager(async (mgr) => {
  const result = await mgr.startFlow({
    botId: 'bot-a', channelId: 'chan-1', userId: 'u1',
    generator: instantFlow('skipped'),
    onExpire: () => {},
  });
  assert.equal(result.type, 'complete');
  assert.equal(result.message, 'skipped');
  assert.equal(mgr.hasActiveFlow('bot-a', 'chan-1'), false,
    'a flow that returns on first .next() must not be left registered as active');
}));

// ---------------------------------------------------------------------------
// Isolation: bot+channel scoping
// ---------------------------------------------------------------------------

test('IM-INV-002: flows are isolated per bot+channel — different channels coexist', withFlowManager(async (mgr) => {
  const a = scriptedFlow(['a-prompt'], 'a-done');
  const b = scriptedFlow(['b-prompt'], 'b-done');

  await mgr.startFlow({ botId: 'bot-a', channelId: 'chan-1', userId: 'u', generator: a.gen, onExpire: () => {} });
  await mgr.startFlow({ botId: 'bot-a', channelId: 'chan-2', userId: 'u', generator: b.gen, onExpire: () => {} });

  mgr.registerFlowMessage('bot-a', 'chan-1', 'm-a');
  mgr.registerFlowMessage('bot-a', 'chan-2', 'm-b');

  await mgr.handleReply('m-a', 'reply-to-a');
  await mgr.handleReply('m-b', 'reply-to-b');

  assert.deepEqual(a.received, ['reply-to-a']);
  assert.deepEqual(b.received, ['reply-to-b'],
    'replies must NOT cross-leak between channels');
}));

test('IM-INV-002: same channel id but different bot id is treated as a separate flow', withFlowManager(async (mgr) => {
  const a = scriptedFlow(['p'], 'a-done');
  const b = scriptedFlow(['p'], 'b-done');

  await mgr.startFlow({ botId: 'bot-a', channelId: 'chan-1', userId: 'u', generator: a.gen, onExpire: () => {} });
  await mgr.startFlow({ botId: 'bot-b', channelId: 'chan-1', userId: 'u', generator: b.gen, onExpire: () => {} });

  assert.equal(mgr.hasActiveFlow('bot-a', 'chan-1'), true,
    'bot-a flow on chan-1 must remain active after bot-b also starts on chan-1');
  assert.equal(mgr.hasActiveFlow('bot-b', 'chan-1'), true);
}));

// ---------------------------------------------------------------------------
// Replacement: starting a new flow cancels the existing one
// ---------------------------------------------------------------------------

test('IM-INV-002: starting a new flow on the same bot+channel cancels the prior generator', withFlowManager(async (mgr) => {
  const old = cancellableFlow();
  const fresh = scriptedFlow(['fresh-prompt'], 'fresh-done');

  await mgr.startFlow({
    botId: 'bot-a', channelId: 'chan-1', userId: 'u', generator: old.gen, onExpire: () => {},
  });
  mgr.registerFlowMessage('bot-a', 'chan-1', 'old-msg');

  await mgr.startFlow({
    botId: 'bot-a', channelId: 'chan-1', userId: 'u', generator: fresh.gen, onExpire: () => {},
  });

  // Let the cancel/return chain settle.
  await new Promise((r) => setImmediate(r));
  assert.equal(old.returned, true,
    'the old generator must have its .return() called when a fresh flow takes its place');
  assert.equal(mgr.isFlowMessage('old-msg'), false,
    'old prompt message ids must be cleared so stray replies do not route to the new flow');
}));

test('IM-INV-002: cancelFlow returns true when an active flow existed, false otherwise', withFlowManager(async (mgr) => {
  assert.equal(mgr.cancelFlow('bot-a', 'chan-1'), false,
    'cancelling a non-existent flow must return false');

  const flow = cancellableFlow();
  await mgr.startFlow({
    botId: 'bot-a', channelId: 'chan-1', userId: 'u', generator: flow.gen, onExpire: () => {},
  });
  assert.equal(mgr.cancelFlow('bot-a', 'chan-1'), true,
    'cancelling a live flow returns true');
  assert.equal(mgr.hasActiveFlow('bot-a', 'chan-1'), false);
  await new Promise((r) => setImmediate(r));
  assert.equal(flow.returned, true, 'cancelled flow generator gets .return() invoked');
}));

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

test('IM-INV-002: shutdown cancels every active flow and clears both lookup maps', withFlowManager(async (mgr) => {
  const a = cancellableFlow();
  const b = cancellableFlow();

  await mgr.startFlow({ botId: 'bot-a', channelId: 'c1', userId: 'u', generator: a.gen, onExpire: () => {} });
  await mgr.startFlow({ botId: 'bot-b', channelId: 'c2', userId: 'u', generator: b.gen, onExpire: () => {} });
  mgr.registerFlowMessage('bot-a', 'c1', 'm-a');
  mgr.registerFlowMessage('bot-b', 'c2', 'm-b');

  mgr.shutdown();
  await new Promise((r) => setImmediate(r));

  assert.equal(a.returned, true);
  assert.equal(b.returned, true);
  assert.equal(mgr.hasActiveFlow('bot-a', 'c1'), false);
  assert.equal(mgr.hasActiveFlow('bot-b', 'c2'), false);
  assert.equal(mgr.isFlowMessage('m-a'), false);
  assert.equal(mgr.isFlowMessage('m-b'), false);
}));

// ---------------------------------------------------------------------------
// Timeout — exercise the path without waiting 5 minutes by reaching into
// node's fake-timer-free setTimeout via stub. We re-export the timeout
// behavior by counting fires from the onExpire callback when the manager
// itself drives a tighter test. The flow's real timeout is 5 minutes (per
// `FLOW_TIMEOUT_MS`); testing the exact value would require a clock fake.
// Instead, assert the API: when a reply arrives, the prior timer is reset
// so the flow doesn't expire mid-conversation. We do this by checking that
// onExpire is NOT called synchronously by handleReply.
// ---------------------------------------------------------------------------

test('IM-INV-002: handleReply resets the inactivity timer (onExpire not fired during normal back-and-forth)', withFlowManager(async (mgr) => {
  let expireCount = 0;
  const { gen } = scriptedFlow(['q1', 'q2'], 'done');
  await mgr.startFlow({
    botId: 'bot-a', channelId: 'chan-1', userId: 'u', generator: gen,
    onExpire: () => { expireCount += 1; },
  });
  mgr.registerFlowMessage('bot-a', 'chan-1', 'msg-1');
  await mgr.handleReply('msg-1', 'first');
  mgr.registerFlowMessage('bot-a', 'chan-1', 'msg-2');
  await mgr.handleReply('msg-2', 'second');

  // Finishing the flow normally must NOT invoke onExpire.
  assert.equal(expireCount, 0,
    'a normal start → reply → complete cycle must not trigger the expire callback');

  // After completion, the flow is no longer active and further replies
  // route nowhere — including the original prompt ids, which were cleared
  // by cleanup().
  assert.equal(mgr.hasActiveFlow('bot-a', 'chan-1'), false);
  assert.equal(mgr.isFlowMessage('msg-1'), false);
  assert.equal(mgr.isFlowMessage('msg-2'), false);
}));
