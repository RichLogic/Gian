#!/usr/bin/env node

import { Readable, Writable } from 'node:stream';
import { writeFile } from 'node:fs/promises';
import { AgentSideConnection, ndJsonStream, RequestError } from '@agentclientprotocol/sdk';

// GROK_TEST_EXT_METHODS=none simulates the published 1.0.41 stdio binary: the
// _meta advertises grokShell and a modern agentVersion, but NO x.ai/* request
// method is registered (every one answers -32601 "Method not found"). The
// default registers the full extension surface.
const EXT_METHODS_REGISTERED = process.env.GROK_TEST_EXT_METHODS !== 'none';

function extDispatch(method, handle) {
  if (!EXT_METHODS_REGISTERED) {
    throw RequestError.methodNotFound(method);
  }
  return handle();
}

if (process.env.GROK_TEST_SPAWN_RECORD) {
  await writeFile(process.env.GROK_TEST_SPAWN_RECORD, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    disableAutoUpdater: process.env.GROK_DISABLE_AUTOUPDATER,
    sandbox: process.env.GROK_SANDBOX,
  }));
}

const FORKED_SESSION_ID = 'native-forked-child';

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
      agentInfo: { name: 'fake-grok', version: '1.0.41-test' },
      _meta: {
        grokShell: true,
        agentVersion: '1.0.41',
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
    return { sessions: [{ sessionId: 'native-existing', cwd: process.cwd(), title: 'Existing' }] };
  },
  async loadSession({ sessionId }) {
    return { sessionId };
  },
  async resumeSession({ sessionId }) {
    return { sessionId };
  },
  async closeSession() {
    return {};
  },
  extMethod: async (method, params) => {
    const record = params && typeof params === 'object' ? params : {};
    return extDispatch(method, () => {
      if (method === 'x.ai/session/delete') {
        return { success: true };
      }
      if (method === 'x.ai/session/rename') {
        return { success: true, title: record.title ?? '' };
      }
      if (method === 'x.ai/session/fork') {
        return {
          newSessionId: FORKED_SESSION_ID,
          chatMessagesCopied: 3,
          updatesCopied: 5,
          planStateCopied: false,
          newCwd: process.cwd(),
          parentSessionId: record.sourceSessionId ?? 'native-new',
        };
      }
      if (method === 'x.ai/interject') {
        return { status: 'queued' };
      }
      if (method === 'x.ai/mcp/list') {
        return { servers: [] };
      }
      if (method === 'x.ai/skills/list') {
        return { skills: [] };
      }
      if (method === 'x.ai/hooks/list') {
        return { hooks: [] };
      }
      if (method === 'x.ai/session/usage') {
        return { usage: {} };
      }
      if (method === 'x.ai/session/update_mcp_servers') {
        return { ok: true };
      }
      throw RequestError.methodNotFound(method);
    });
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
