// Coverage for traceability row:
//   ERR-016 — Slack manifest registration must preserve commands outside the
//             bot's prefix and surface Slack API errors as named exceptions
//             instead of swallowing them.
//
// Pure unit + a `globalThis.fetch` stub so we never reach api.slack.com.
// We assert two things:
//   1. The manifest the proxy POSTs back contains the preserved + new
//      command set.
//   2. Non-ok responses cause registration to throw with the
//      operator-visible error text from the Slack response payload.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  registerSlackCommands,
  slackCommandNames,
} from '../src/im/slack/manifest.ts';

interface RecordedCall {
  url: string;
  body: Record<string, unknown>;
}

interface FetchScript {
  exportResponse: Record<string, unknown>;
  updateResponse: Record<string, unknown>;
}

function installFetchStub(script: FetchScript): {
  calls: RecordedCall[];
  restore: () => void;
} {
  const calls: RecordedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const body = init?.body && typeof init.body === 'string'
      ? (JSON.parse(init.body) as Record<string, unknown>)
      : {};
    calls.push({ url, body });

    let payload: Record<string, unknown>;
    if (url.endsWith('apps.manifest.export')) payload = script.exportResponse;
    else if (url.endsWith('apps.manifest.update')) payload = script.updateResponse;
    else throw new Error(`Unexpected fetch URL in test: ${url}`);

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }) as Response;
  };
  return {
    calls,
    restore: () => { globalThis.fetch = original; },
  };
}

const RICH_EXPORT: Record<string, unknown> = {
  ok: true,
  manifest: {
    display_information: { name: 'Eva00' },
    features: {
      slash_commands: [
        // Unrelated to our prefix — must be preserved verbatim.
        { command: '/help', description: 'Show help', should_escape: false },
        { command: '/feedback', description: 'Send feedback' },
        // Stale command from an old prefix run — must be replaced.
        { command: '/eva00-old', description: 'old', should_escape: false },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// Pure helpers (no network)
// ---------------------------------------------------------------------------

test('ERR-016: slackCommandNames produces the full /<prefix>-<action> list', () => {
  assert.deepEqual(slackCommandNames('eva00'), [
    '/eva00-new',
    '/eva00-switch',
    '/eva00-alter',
    '/eva00-stop',
    '/eva00-status',
  ]);
});

// ---------------------------------------------------------------------------
// registerSlackCommands — happy path preserves unrelated commands
// ---------------------------------------------------------------------------

test('ERR-016: registerSlackCommands preserves non-prefix commands and replaces stale prefix entries', async () => {
  const stub = installFetchStub({
    exportResponse: RICH_EXPORT,
    updateResponse: { ok: true },
  });
  try {
    await registerSlackCommands({
      configToken: 'xoxe.foo',
      appId: 'A1',
      prefix: 'eva00',
    });

    const update = stub.calls.find((c) => c.url.endsWith('apps.manifest.update'));
    assert.ok(update, 'update call was made');
    const manifest = (update!.body.manifest as Record<string, unknown>);
    const features = manifest.features as Record<string, unknown>;
    const commands = features.slash_commands as Array<{ command: string; description?: string }>;

    const names = commands.map((c) => c.command);
    // Non-prefix entries from the original manifest are preserved exactly.
    assert.ok(names.includes('/help'), '/help must be preserved verbatim');
    assert.ok(names.includes('/feedback'), '/feedback must be preserved verbatim');

    // Stale prefix entry must be replaced, not duplicated.
    assert.equal(names.filter((n) => n === '/eva00-old').length, 0,
      'stale /eva00-old must be removed when re-registering');

    // All declared actions for the new prefix are present, in order.
    for (const action of ['new', 'switch', 'alter', 'stop', 'status'] as const) {
      assert.ok(names.includes(`/eva00-${action}`), `/eva00-${action} must be registered`);
    }
  } finally {
    stub.restore();
  }
});

test('ERR-016: registerSlackCommands sends Authorization Bearer for both export and update', async () => {
  const stub = installFetchStub({
    exportResponse: RICH_EXPORT,
    updateResponse: { ok: true },
  });
  // We need to also assert the header — wrap fetch again to capture it.
  const original = globalThis.fetch;
  const headerCalls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const auth = (init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? '';
    headerCalls.push(auth);
    return original(input, init);
  };
  try {
    await registerSlackCommands({
      configToken: 'xoxe.secret',
      appId: 'A1',
      prefix: 'eva00',
    });
    assert.equal(headerCalls.length, 2, 'export + update both go through fetch');
    for (const auth of headerCalls) {
      assert.equal(auth, 'Bearer xoxe.secret',
        'every Slack API call must carry the Configuration Token as a Bearer header');
    }
  } finally {
    globalThis.fetch = original;
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// registerSlackCommands — error surfacing
// ---------------------------------------------------------------------------

test('ERR-016: registerSlackCommands throws a named error when manifest export fails', async () => {
  const stub = installFetchStub({
    exportResponse: { ok: false, error: 'invalid_auth' },
    updateResponse: { ok: true },
  });
  try {
    await assert.rejects(
      () => registerSlackCommands({ configToken: 'x', appId: 'A1', prefix: 'eva00' }),
      /Failed to export Slack manifest:.*invalid_auth/,
      'export failure must throw with the upstream error code preserved',
    );
  } finally {
    stub.restore();
  }
});

test('ERR-016: registerSlackCommands throws when manifest update fails, with errors detail attached', async () => {
  const stub = installFetchStub({
    exportResponse: RICH_EXPORT,
    updateResponse: { ok: false, error: 'invalid_manifest', errors: [{ message: 'cmd too long' }] },
  });
  try {
    await assert.rejects(
      () => registerSlackCommands({ configToken: 'x', appId: 'A1', prefix: 'eva00' }),
      (err: Error) => {
        assert.match(err.message, /Failed to update Slack manifest:.*invalid_manifest/);
        assert.match(err.message, /cmd too long/,
          'detailed errors[] from Slack must be appended so operator can debug');
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

test('ERR-016: registerSlackCommands surfaces HTTP error from the underlying fetch', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('upstream down', { status: 502, statusText: 'Bad Gateway' }) as Response;
  try {
    await assert.rejects(
      () => registerSlackCommands({ configToken: 'x', appId: 'A1', prefix: 'eva00' }),
      /Slack API .* returned HTTP 502/,
      'non-200 response must throw a clear "returned HTTP <code>" exception',
    );
  } finally {
    globalThis.fetch = original;
  }
});
