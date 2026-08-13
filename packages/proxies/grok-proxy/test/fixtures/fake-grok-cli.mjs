#!/usr/bin/env node

import { Readable, Writable } from 'node:stream';
import { writeFile } from 'node:fs/promises';
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

if (process.env.GROK_TEST_SPAWN_RECORD) {
  await writeFile(process.env.GROK_TEST_SPAWN_RECORD, JSON.stringify({
    argv: process.argv.slice(2),
    disableAutoUpdater: process.env.GROK_DISABLE_AUTOUPDATER,
    sandbox: process.env.GROK_SANDBOX,
  }));
}

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

new AgentSideConnection(() => ({
  async initialize() {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      },
      agentInfo: { name: 'fake-grok', version: '0.0.0-test' },
    };
  },
}), stream);
