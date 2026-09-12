/**
 * Named fixture scenarios — the single source for screenshot evidence
 * (`?fixture=<name>`) and for tests that want a precomposed state. Each
 * entry is plain controller state; nothing here touches a network.
 */

import type { RemoteInteraction } from '@gian/remote-protocol';
import type { FixtureScenario } from './controller/fixture.js';
import {
  sampleHosts,
  sampleSessions,
  sampleTasks,
  sampleTranscript,
} from './controller/fixture.js';

export function sampleInteraction(partial?: Partial<RemoteInteraction>): RemoteInteraction {
  return {
    id: 'int-1',
    revision: 'irev-1',
    session_id: 's-1',
    turn_id: 'turn-1',
    kind: 'approval',
    created_at: new Date().toISOString(),
    presentation: {
      title: 'Run command',
      description: '需要在仓库根目录执行',
      risk: 'medium',
      subject: 'git config core.hooksPath .husky',
      actions: [
        { id: 'act-allow', label: 'Allow once', tone: 'default' },
        { id: 'act-decline', label: 'Decline', tone: 'danger' },
      ],
    },
    ...partial,
  };
}

const base = Date.UTC(2026, 8, 1, 13, 2, 0);

export const FIXTURE_SCENARIOS: Record<string, FixtureScenario> = {
  /** F1: desktop chat, active turn, queue with two entries. */
  chat: {},

  /** Idle session (no active turn), plain Send. */
  'chat-idle': {
    hostData: {
      'host-home': {
        workspaces: [{ id: 'ws-1', name: '~/Coding/Gian-Dev' }],
        tasks: sampleTasks(),
        sessions: [
          {
            ...sampleSessions()[1]!,
            status: 'done',
          },
        ],
        transcripts: { 's-2': sampleTranscript() },
      },
    },
    view: { kind: 'chat', sessionId: 's-2' },
  },

  /** F2: file open (ready) — wide shows the right panel, mid/narrow a page. */
  'file-ready': {
    mobilePage: 'file',
    fileViewer: {
      status: 'ready',
      handle: { id: 'file-1', sessionId: 's-1', label: 'pre-push', dirLabel: '.husky/' },
      text: '#!/bin/sh\n# GianDev: push 前跑快速回归门\n# 跳过：git push --no-verify\nset -e\n\npnpm verify:quick -- --base origin/main\n',
      sizeLabel: '128 B',
    },
  },

  'file-loading': {
    mobilePage: 'file',
    fileViewer: {
      status: 'loading',
      handle: { id: 'file-1', sessionId: 's-1', label: 'pre-push', dirLabel: '.husky/' },
    },
  },

  'file-too-large': {
    mobilePage: 'file',
    fileViewer: {
      status: 'too_large',
      handle: { id: 'file-2', sessionId: 's-1', label: 'dump.sql', dirLabel: 'artifacts/' },
      limitLabel: '1 MB',
    },
  },

  /** F6: Host offline — stale snapshot, mutations disabled. */
  'host-offline': {
    connection: { kind: 'host_offline', lastSeenAt: base },
  },

  'browser-offline': {
    connection: { kind: 'browser_offline' },
  },

  'relay-reconnecting': {
    connection: { kind: 'relay_reconnecting', attempt: 2 },
  },

  resyncing: {
    connection: { kind: 'resyncing', synced: 3, total: 8 },
  },

  'version-mismatch': {
    connection: { kind: 'version_mismatch', requiredVersion: '0.5.4', hostVersion: '0.5.2' },
  },

  'device-revoked': {
    connection: { kind: 'device_revoked' },
  },

  /** Unknown outcome strip (§14). */
  'unknown-outcome': {
    unknownCommandId: 'cmd-0001',
  },

  /** F12: PRECONDITION_FAILED — queue replaced wholesale + notice. */
  'queue-conflict': {
    queueNotice: { kind: 'replaced-remotely' },
  },

  /** Interaction card pending in the transcript. */
  'interaction-pending': {
    hostData: {
      'host-home': {
        workspaces: [{ id: 'ws-1', name: '~/Coding/Gian-Dev' }],
        tasks: sampleTasks(),
        sessions: sampleSessions(),
        interactions: [sampleInteraction()],
        transcripts: { 's-1': sampleTranscript() },
      },
    },
  },

  'interaction-question': {
    hostData: {
      'host-home': {
        workspaces: [{ id: 'ws-1', name: '~/Coding/Gian-Dev' }],
        tasks: sampleTasks(),
        sessions: sampleSessions(),
        interactions: [
          sampleInteraction({
            id: 'int-q',
            kind: 'question',
            presentation: {
              title: '这次改动要覆盖哪些位置？',
              description: '提交前确认一下范围：',
              risk: 'low',
              actions: [
                { id: 'act-submit', label: 'Submit', tone: 'default' },
                { id: 'act-cancel', label: 'Cancel', tone: 'danger' },
              ],
              inputs: [
                {
                  id: 'in-scope',
                  label: '覆盖范围',
                  type: 'multi_select',
                  options: [
                    { value: 'hook', label: '.husky/pre-push', description: 'hook 本体' },
                    { value: 'pkg', label: 'package.json', description: '补 verify:quick script 说明' },
                    { value: 'contrib', label: 'CONTRIBUTING.md', description: '贡献指南同步' },
                  ],
                },
              ],
            },
          }),
        ],
        transcripts: { 's-1': sampleTranscript() },
      },
    },
  },

  /** F11: New Chat form (desktop in main panel / narrow full page). */
  'new-chat': {
    view: { kind: 'new-chat', presetTaskId: 'task-1' },
    mobilePage: 'new-chat',
  },

  /** F7/F8: Settings. */
  settings: {
    view: { kind: 'settings' },
    mobilePage: 'settings',
  },

  /** Narrow rail page (F4). */
  'rail-mobile': {
    mobilePage: 'rail',
  },

  /** B1 pairing pages. */
  'pair-code': {
    auth: { kind: 'pairing', pairing: { kind: 'enter-code', attemptsLeft: 5 } },
  },
  'pair-qr': {
    auth: { kind: 'pairing', pairing: { kind: 'qr-confirm', hostName: 'MacBook Pro · 家里', deviceName: 'iPhone 17 Pro' } },
  },
  'pair-waiting': {
    auth: { kind: 'pairing', pairing: { kind: 'waiting', deviceName: 'iPhone 17 Pro', expiresAt: Date.now() + 240_000 } },
  },
  'pair-failed-expired': {
    auth: { kind: 'pairing', pairing: { kind: 'failed', reason: 'expired' } },
  },
  'pair-failed-rejected': {
    auth: { kind: 'pairing', pairing: { kind: 'failed', reason: 'rejected' } },
  },
  'pair-failed-rate-limited': {
    auth: { kind: 'pairing', pairing: { kind: 'failed', reason: 'attempt-limit' } },
  },
  'pair-failed-host-offline': {
    auth: { kind: 'pairing', pairing: { kind: 'failed', reason: 'host-offline', hostName: 'MacBook Pro · 家里' } },
  },
  'challenge-login': {
    auth: { kind: 'challenge-login', hosts: sampleHosts() },
    connection: { kind: 'resyncing', synced: 0, total: 1 },
    snapshotReceivedAt: null,
  },
};
