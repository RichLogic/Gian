#!/usr/bin/env node

import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

const MODE_OPTIONS = [
  {
    type: 'select',
    category: 'mode',
    id: 'mode',
    name: 'Mode',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'auto', name: 'Auto' },
    ],
  },
];

let nextSession = 0;

new AgentSideConnection((connection) => ({
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

  async newSession() {
    nextSession += 1;
    const sessionId = `native-fake-${nextSession}`;
    await connection.sessionUpdate({
      sessionId,
      update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
    });
    return { sessionId, configOptions: MODE_OPTIONS };
  },

  async loadSession() {
    return {};
  },

  async resumeSession() {
    return {};
  },

  async listSessions() {
    return { sessions: [], nextCursor: null };
  },

  async setSessionConfigOption(params) {
    if (params.configId !== 'mode') {
      throw new Error(`unknown config option ${params.configId}`);
    }
    return { configOptions: MODE_OPTIONS };
  },

  async prompt(params) {
    if (process.env.FAKE_KIMI_PERMISSION === '1') {
      const permission = await connection.requestPermission({
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: 'tool-1',
          title: 'Run command',
          kind: 'execute',
        },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      });
      if (permission.outcome.outcome !== 'selected') {
        return { stopReason: 'cancelled' };
      }
    }
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'fake answer' },
      },
    });
    return {
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    };
  },

  async cancel() {},

  async closeSession() {},
}), stream);
