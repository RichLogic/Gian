#!/usr/bin/env node

import { Readable, Writable } from 'node:stream';
import { writeFile } from 'node:fs/promises';
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

if (process.env.GROK_TEST_SPAWN_RECORD) {
  await writeFile(process.env.GROK_TEST_SPAWN_RECORD, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    disableAutoUpdater: process.env.GROK_DISABLE_AUTOUPDATER,
    sandbox: process.env.GROK_SANDBOX,
  }));
}

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

new AgentSideConnection((agentConn) => ({
  async initialize() {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      },
      agentInfo: { name: 'fake-grok', version: '1.0.3-test' },
      _meta: {
        modelState: {
          currentModelId: 'grok-4.6',
          availableModels: [{
            modelId: 'grok-4.6',
            name: 'Grok 4.6',
            _meta: {
              supportsReasoningEffort: true,
              reasoningEffort: 'xhigh',
              reasoningEfforts: [
                { id: 'xhigh', value: 'xhigh', label: 'Extra High', default: true },
                { id: 'high', value: 'high', label: 'High', default: false },
              ],
            },
          }],
        },
        availableCommands: [
          { name: 'compact', description: 'Compress history' },
          { name: 'fork', description: 'Fork' },
          { name: 'always-approve', description: 'Toggle always-approve' },
        ],
      },
    };
  },
  async newSession() {
    return { sessionId: 'native-new' };
  },
  async listSessions() {
    return { sessions: [{ sessionId: 'native-existing', cwd: process.cwd() }] };
  },
  async closeSession() {
    return {};
  },
  async prompt() {
    await agentConn.sessionUpdate({
      sessionId: 'native-new',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'pong' },
      },
    });
    return { stopReason: 'end_turn' };
  },
}), stream);
