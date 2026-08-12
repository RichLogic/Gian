#!/usr/bin/env node

import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

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
      agentInfo: { name: 'fake-kimi', version: '0.0.0-test' },
    };
  },
}), stream);
