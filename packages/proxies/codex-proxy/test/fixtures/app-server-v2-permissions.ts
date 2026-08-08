/** Codex app-server v2 thread bootstrap shapes used by the Custom preset. */
export const CODEX_APP_SERVER_V2_NAMED_PERMISSIONS = {
  fixtureVersion: 'codex-app-server/v2',
  response: {
    thread: { id: 'thread-configured' },
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'workspaceWrite', writableRoots: ['/repo'], networkAccess: false },
    activePermissionProfile: { id: 'my-profile', extends: ':workspace' },
  },
} as const;

export const CODEX_APP_SERVER_V2_GRANULAR_PERMISSIONS = {
  fixtureVersion: 'codex-app-server/v2-granular',
  response: {
    thread: { id: 'thread-granular' },
    approvalPolicy: {
      granular: {
        sandbox_approval: true,
        rules: true,
        skill_approval: true,
        request_permissions: true,
        mcp_elicitations: true,
      },
    },
    approvalsReviewer: 'guardian_subagent',
    sandbox: { type: 'readOnly' },
    activePermissionProfile: null,
  },
} as const;

export const CODEX_APP_SERVER_V2_DEFAULT_ELIDED_GRANULAR_PERMISSIONS = {
  fixtureVersion: 'codex-app-server/v2-granular-default-elided',
  response: {
    thread: { id: 'thread-granular-defaults' },
    approvalPolicy: {
      granular: {
        sandbox_approval: true,
        rules: true,
        mcp_elicitations: true,
      },
    },
    approvalsReviewer: 'user',
    sandbox: { type: 'workspaceWrite' },
    activePermissionProfile: null,
  },
} as const;

export const CODEX_APP_SERVER_V2_EXTERNAL_SANDBOX_PERMISSIONS = {
  fixtureVersion: 'codex-app-server/v2-external-sandbox-default-elided',
  response: {
    thread: { id: 'thread-external-sandbox' },
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'externalSandbox', provider: 'fixture' },
    activePermissionProfile: null,
  },
} as const;

export const CODEX_APP_SERVER_UNKNOWN_PERMISSIONS = [
  {
    fixtureVersion: 'codex-app-server/future-policy',
    response: {
      thread: { id: 'thread-future-policy' },
      approvalPolicy: { delegated: true },
      approvalsReviewer: 'user',
      sandbox: { type: 'readOnly' },
    },
  },
  {
    fixtureVersion: 'codex-app-server/malformed-granular',
    response: {
      thread: { id: 'thread-bad-granular' },
      approvalPolicy: { granular: { sandbox_approval: 'yes' } },
      approvalsReviewer: 'user',
      sandbox: { type: 'readOnly' },
    },
  },
  {
    fixtureVersion: 'codex-app-server/future-granular-envelope',
    response: {
      thread: { id: 'thread-future-granular' },
      approvalPolicy: {
        granular: {
          sandbox_approval: true,
          rules: true,
          skill_approval: true,
          request_permissions: true,
          mcp_elicitations: true,
        },
        delegated: true,
      },
      approvalsReviewer: 'user',
      sandbox: { type: 'readOnly' },
    },
  },
  {
    fixtureVersion: 'codex-app-server/future-sandbox',
    response: {
      thread: { id: 'thread-future-sandbox' },
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: { type: 'ambientHostAccess' },
      activePermissionProfile: null,
    },
  },
  {
    fixtureVersion: 'codex-app-server/malformed-known-sandbox',
    response: {
      thread: { id: 'thread-malformed-known-sandbox' },
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: { type: 'workspaceWrite', writableRoots: 'not-an-array', networkAccess: 1 },
      activePermissionProfile: null,
    },
  },
] as const;
