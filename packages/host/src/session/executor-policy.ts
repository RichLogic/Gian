import type { ApprovalMode, Executor } from '@gian/shared';

export function proxyTurnParamsFor(
  executor: Exclude<Executor, 'kimi' | 'grok'>,
  mode: ApprovalMode,
): {
  permissionMode?: 'plan' | 'default' | 'auto' | 'bypassPermissions';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  useConfiguredPermissions?: boolean;
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  approvalsReviewer?: 'user' | 'auto_review';
  collaborationMode?: 'plan' | 'default';
} {
  if (executor === 'claude') {
    switch (mode) {
      case 'plan': return { permissionMode: 'plan' };
      case 'ask': return { permissionMode: 'default' };
      case 'auto': return { permissionMode: 'auto' };
      case 'full-access':
      case 'custom':
        return { permissionMode: 'default' };
    }
  }
  switch (mode) {
    case 'plan':
      return {
        sandbox: 'read-only',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        collaborationMode: 'plan',
      };
    case 'ask':
      return {
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
      };
    case 'auto':
      return {
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
      };
    case 'custom':
      return { useConfiguredPermissions: true };
    case 'full-access':
      return {
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
        approvalsReviewer: 'auto_review',
      };
  }
}

export function assertApprovalModeAllowed(executor: Executor, mode: ApprovalMode): void {
  if ((mode === 'custom' || mode === 'full-access') && executor !== 'codex') {
    throw new Error(`${mode} approval mode is codex-only`);
  }
}
